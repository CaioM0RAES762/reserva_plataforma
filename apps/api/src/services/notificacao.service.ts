import { sql } from "../db/pool.js";
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
