import type { StatusReserva } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { resolverTemplateEfetivo } from "./checklist.service.js";
import { publicarEventoGlobal } from "./eventos.service.js";

// Início e conclusão de uso passaram a ter DOIS gatilhos — o clique do usuário
// (PATCH /reservas/:id/status) e o worker de automação — e a regra de negócio precisa ser
// exatamente a mesma nos dois. Este módulo é essa regra única: as rotas e o worker chamam
// as mesmas funções, ninguém reimplementa "pode iniciar?" por conta própria.
export type OrigemTransicao = "manual" | "automatica";

export interface EstadoChecklistReserva {
  exigido: boolean;
  finalizado: boolean;
  todosConformes: boolean | null;
}

// Usado pelo gate de aprovação (POST /aprovar, a barreira principal), pelo gate de início de
// uso (defesa redundante) e pela validação do início automático — os três precisam da mesma
// leitura, e ela depende da configuração da plataforma, não da categoria.
export async function buscarEstadoChecklist(
  plataformaId: string,
  reservaId: string
): Promise<EstadoChecklistReserva> {
  const { templateId } = await resolverTemplateEfetivo(plataformaId);
  if (!templateId) {
    return { exigido: false, finalizado: true, todosConformes: null };
  }
  const pool = await getPool();
  const result = await pool
    .request()
    .input("reserva_id", sql.UniqueIdentifier, reservaId)
    .query<{ finalizado_em: Date | null; todos_conformes: boolean }>(
      "SELECT finalizado_em, todos_conformes FROM ChecklistPreenchido WHERE reserva_id = @reserva_id"
    );
  const linha = result.recordset[0];
  return {
    exigido: true,
    finalizado: Boolean(linha?.finalizado_em),
    todosConformes: linha?.finalizado_em ? linha.todos_conformes : null,
  };
}

export type ResultadoTransicao =
  | { aplicada: true; novoStatus: StatusReserva }
  // `aplicada: false` cobre duas situações que, do ponto de vista de quem chamou, exigem a
  // mesma reação (não repetir efeito colateral nenhum): a reserva não estava mais no estado
  // de partida — porque outra execução, ou o clique do usuário, já fez a transição — ou uma
  // regra de negócio impediu a mudança.
  | { aplicada: false; motivo: string };

interface ParametrosTransicao {
  reservaId: string;
  origem: OrigemTransicao;
  // NULL quando a origem é automática — LogAuditoria.usuario_id é nullable exatamente para
  // registrar ações que não partiram de uma pessoa.
  usuarioId: string | null;
}

// Idempotência e proteção contra corrida vêm do mesmo mecanismo: um UPDATE condicional que
// carrega o estado de partida no próprio WHERE. Quem executa primeiro encontra a linha e a
// altera; quem chega depois não casa mais o WHERE, recebe 0 linhas e para — não há leitura
// seguida de escrita, então não existe janela entre "verifiquei" e "gravei".
//
// Na prática: o clique do usuário e o job disparando no mesmo instante produzem uma única
// transição, um único registro de auditoria e um único evento SSE. O UPDATE toma lock
// exclusivo na linha; o segundo espera, relê sob o lock e vê o status já alterado.
async function aplicarTransicao(
  params: ParametrosTransicao & {
    statusDe: StatusReserva;
    statusPara: StatusReserva;
    campoHoraReal: "hora_inicio_real" | "hora_fim_real";
    acaoAuditoria: string;
  }
): Promise<ResultadoTransicao> {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const atualizacao = await transaction
      .request()
      .input("id", sql.UniqueIdentifier, params.reservaId)
      .input("status_de", sql.VarChar, params.statusDe)
      .input("status_para", sql.VarChar, params.statusPara)
      .query<{ id: string }>(
        `UPDATE Reserva
         SET status = @status_para,
             ${params.campoHoraReal} = CAST(GETDATE() AS TIME),
             atualizado_em = SYSUTCDATETIME()
         OUTPUT INSERTED.id
         WHERE id = @id AND status = @status_de`
      );

    if (atualizacao.recordset.length === 0) {
      await transaction.rollback();
      return {
        aplicada: false,
        motivo: `Reserva não está mais no status "${params.statusDe}" — transição já aplicada por outra ação.`,
      };
    }

    // A auditoria entra na MESMA transação do UPDATE: só é gravada por quem de fato mudou o
    // status, então rodar o job duas vezes nunca duplica o histórico.
    await transaction
      .request()
      .input("usuario_id", sql.UniqueIdentifier, params.usuarioId)
      .input("acao", sql.VarChar, params.acaoAuditoria)
      .input("entidade_id", sql.UniqueIdentifier, params.reservaId)
      .input(
        "detalhes",
        sql.NVarChar,
        JSON.stringify({
          origem: params.origem === "automatica" ? "AUTOMATICA" : "MANUAL",
          statusAnterior: params.statusDe,
          statusNovo: params.statusPara,
        })
      )
      .query(
        `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
         VALUES (@usuario_id, @acao, 'Reserva', @entidade_id, @detalhes)`
      );

    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    throw err;
  }

  // Fora da transação e só no caminho em que a transição realmente aconteceu: Calendário,
  // Central de Operações e Reservas revalidam sozinhos, sem polling no navegador.
  publicarEventoGlobal("reserva.status_alterado", {
    id: params.reservaId,
    status: params.statusPara,
    origem: params.origem,
  });

  return { aplicada: true, novoStatus: params.statusPara };
}

export interface ContextoReservaTransicao {
  plataformaId: string;
  plataformaStatus: string;
}

// RN-RES-12: uma plataforma que exige checklist só entra em uso com ele finalizado e sem
// não conformidade impeditiva. Vale igual para o clique e para o job — o início automático
// não é um atalho para furar regra de segurança.
export async function iniciarUsoReserva(
  params: ParametrosTransicao & { contexto: ContextoReservaTransicao }
): Promise<ResultadoTransicao> {
  // RN-PLAT-01/04: uma plataforma que entrou em manutenção/inativa depois da aprovação não
  // pode ser colocada em uso — nem manualmente, nem pelo relógio.
  if (params.contexto.plataformaStatus === "inativa" || params.contexto.plataformaStatus === "manutencao") {
    return {
      aplicada: false,
      motivo: `Plataforma está em "${params.contexto.plataformaStatus}" e não pode iniciar uso.`,
    };
  }

  const checklist = await buscarEstadoChecklist(params.contexto.plataformaId, params.reservaId);
  if (checklist.exigido && !checklist.finalizado) {
    return {
      aplicada: false,
      motivo:
        "Esta plataforma exige checklist de segurança antes do início de uso (NR-18/NR-35) e ele ainda não foi concluído.",
    };
  }
  if (checklist.exigido && !checklist.todosConformes) {
    return {
      aplicada: false,
      motivo:
        "O checklist de segurança desta reserva tem item não conforme impeditivo — início de uso bloqueado até revisão da plataforma (RN-CHK-02).",
    };
  }

  return aplicarTransicao({
    ...params,
    statusDe: "agendada",
    statusPara: "em_uso",
    campoHoraReal: "hora_inicio_real",
    acaoAuditoria: "iniciar_uso_reserva",
  });
}

export async function concluirReserva(params: ParametrosTransicao): Promise<ResultadoTransicao> {
  return aplicarTransicao({
    ...params,
    statusDe: "em_uso",
    statusPara: "concluida",
    campoHoraReal: "hora_fim_real",
    acaoAuditoria: "concluir_reserva",
  });
}
