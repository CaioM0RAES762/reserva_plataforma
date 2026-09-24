import { getPool, sql } from "../db/pool.js";
import type { TipoNotificacao } from "@plataformares/shared";

export interface NotificacaoInput {
  usuarioId: string;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  link?: string | null;
}

export interface NotificacaoRegistrada {
  id: string;
  usuarioId: string;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  link: string | null;
  lida: boolean;
  criadoEm: string;
}

// Grava a Notificacao na MESMA transação da operação que a originou (invariante de
// auditoria do MASTER.md Seção 2, aplicada aqui por analogia — nunca best-effort/assíncrono
// mesmo sendo uma entidade nova). O evento SSE notificacao.nova é publicado pelo chamador
// DEPOIS do commit (mesmo padrão já usado para e-mail nas rotas de reserva/aprovação).
export async function registrarNotificacao(
  transaction: sql.Transaction,
  input: NotificacaoInput
): Promise<NotificacaoRegistrada> {
  const result = await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, input.usuarioId)
    .input("tipo", sql.VarChar, input.tipo)
    .input("titulo", sql.NVarChar, input.titulo)
    .input("mensagem", sql.NVarChar, input.mensagem)
    .input("link", sql.NVarChar, input.link ?? null)
    .query<{ id: string; criado_em: Date }>(
      `INSERT INTO Notificacao (usuario_id, tipo, titulo, mensagem, link)
       OUTPUT INSERTED.id, INSERTED.criado_em
       VALUES (@usuario_id, @tipo, @titulo, @mensagem, @link)`
    );
  const row = result.recordset[0];
  return {
    id: row.id,
    usuarioId: input.usuarioId,
    tipo: input.tipo,
    titulo: input.titulo,
    mensagem: input.mensagem,
    link: input.link ?? null,
    lida: false,
    criadoEm: row.criado_em.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Canal e-mail
// ---------------------------------------------------------------------------------------

/* Só eventos importantes de reserva viram e-mail; o resto (comentário, etc.) fica no sino.
   A notificação interna já foi gravada (e confirmada) antes de chegar aqui: o e-mail é um
   canal ADICIONAL e nunca desfaz nem condiciona a operação que o originou. */
export const TIPOS_NOTIFICACAO_COM_EMAIL: readonly TipoNotificacao[] = [
  "reserva_pendente",
  "reserva_aprovada",
  "reserva_rejeitada",
  "reserva_substituida",
  "reserva_cancelada",
];

export type EnfileirarEmail = (dados: {
  destinatario: string;
  assunto: string;
  corpoHtml: string;
  corpoTexto?: string;
}) => Promise<void>;

function dominioDoEmail(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "?";
}

/**
 * Enfileira o e-mail de cada notificação (fila BullMQ `email`, com retry; o worker chama o
 * provedor configurado por EMAIL_PROVIDER). Destinatário = e-mail REAL cadastrado no usuário
 * ativo — nunca montado a partir do nome. Sem e-mail cadastrado, loga e segue.
 *
 * Chamar DEPOIS do commit e sem `await` na rota: um Redis/SMTP indisponível não pode segurar
 * nem reverter a resposta. Falhas são logadas aqui; falhas de entrega, pelo worker.
 *
 * Logs (sem corpo, sem credencial, destinatário só pelo domínio):
 *   [EMAIL][notificacao] enfileirado     → e-mail entrou na fila
 *   [EMAIL][notificacao] sem-email       → usuário sem e-mail/inativo, envio impossível
 *   [EMAIL][notificacao] falha-enfileirar → erro ao enfileirar (Redis etc.)
 * e, no worker (email.service): "tentativa iniciada" → "aceito" (messageId) | "rejeitado/erro".
 */
export async function despacharEmailsDeNotificacoes(
  notificacoes: NotificacaoRegistrada[],
  deps: { enfileirar?: EnfileirarEmail; buscarEmails?: (ids: string[]) => Promise<Map<string, string>> } = {}
): Promise<void> {
  const elegiveis = notificacoes.filter((n) => TIPOS_NOTIFICACAO_COM_EMAIL.includes(n.tipo));
  if (elegiveis.length === 0) return;

  const buscarEmails = deps.buscarEmails ?? buscarEmailsAtivos;
  const enfileirar = deps.enfileirar ?? (async (dados) => (await import("./queue.js")).enfileirarEmail(dados));
  const { templateNotificacaoReserva } = await import("./email.service.js");

  let emails: Map<string, string>;
  try {
    emails = await buscarEmails([...new Set(elegiveis.map((n) => n.usuarioId))]);
  } catch (err) {
    console.error(`[EMAIL][notificacao] falha-enfileirar motivo="leitura de destinatários: ${(err as Error).message}"`);
    return;
  }

  for (const notificacao of elegiveis) {
    const email = emails.get(notificacao.usuarioId.toLowerCase());
    if (!email) {
      console.warn(
        `[EMAIL][notificacao] sem-email notificationType=${notificacao.tipo} userId=${notificacao.usuarioId} notificacaoId=${notificacao.id}`
      );
      continue;
    }
    const { assunto, corpoHtml, corpoTexto } = templateNotificacaoReserva({
      titulo: notificacao.titulo,
      mensagem: notificacao.mensagem,
      link: notificacao.link,
    });
    try {
      await enfileirar({ destinatario: email, assunto, corpoHtml, corpoTexto });
      console.info(
        `[EMAIL][notificacao] enfileirado notificationType=${notificacao.tipo} userId=${notificacao.usuarioId} domain=${dominioDoEmail(email)} notificacaoId=${notificacao.id}`
      );
    } catch (err) {
      console.error(
        `[EMAIL][notificacao] falha-enfileirar notificationType=${notificacao.tipo} userId=${notificacao.usuarioId} motivo="${(err as Error).message}"`
      );
    }
  }
}

async function buscarEmailsAtivos(ids: string[]): Promise<Map<string, string>> {

  const pool = await getPool();
  const dbRequest = pool.request();
  ids.forEach((id, i) => dbRequest.input(`id${i}`, sql.UniqueIdentifier, id));
  const result = await dbRequest.query<{ id: string; email: string | null }>(
    `SELECT id, email FROM Usuario WHERE ativo = 1 AND id IN (${ids.map((_, i) => `@id${i}`).join(", ")})`
  );
  const mapa = new Map<string, string>();
  for (const row of result.recordset) {
    if (row.email?.trim()) mapa.set(row.id.toLowerCase(), row.email.trim());
  }
  return mapa;
}
