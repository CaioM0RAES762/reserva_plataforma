import { calcularMinutosDeUso, OFFSET_BRASILIA_MINUTOS, type StatusReserva } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { publicarEventoGlobal } from "./eventos.service.js";

/* Hora civil de Brasília (HH:mm) — o mesmo referencial de Reserva.hora_inicio/hora_fim.
   hora_inicio_real/hora_fim_real eram gravadas com GETDATE(), que depende do fuso do
   servidor de banco (UTC no Azure SQL): misturá-las com o horário agendado, como o
   horímetro precisa fazer, daria desvios de 3h. */
export function horaAtualBrasilia(agora: Date = new Date()): string {
  return new Date(agora.getTime() + OFFSET_BRASILIA_MINUTOS * 60_000).toISOString().slice(11, 16);
}

/**
 * Contabiliza no horímetro da plataforma o uso real de uma reserva — exatamente uma vez.
 *
 * Deve rodar DENTRO da transação que encerrou o uso (conclusão, cancelamento em uso,
 * substituição em uso), depois de `hora_fim_real` gravada. A idempotência está no WHERE:
 * `uso_contabilizado_minutos IS NULL` só casa na primeira execução — retry, job repetido,
 * clique duplo ou chamada concorrente encontram a coluna já preenchida e não somam nada.
 * A linha já está com lock exclusivo (o UPDATE de status veio antes na mesma transação),
 * então não há janela entre ler os horários e marcar a reserva.
 */
export async function contabilizarUsoReserva(
  transaction: sql.Transaction,
  reservaId: string
): Promise<number | null> {
  const leitura = await transaction
    .request()
    .input("id", sql.UniqueIdentifier, reservaId)
    .query<{
      plataforma_id: string;
      hora_inicio: string;
      hora_fim: string;
      hora_inicio_real: string | null;
      hora_fim_real: string | null;
      inicio_automatico: boolean;
      uso_contabilizado_minutos: number | null;
    }>(
      `SELECT plataforma_id, CONVERT(varchar(5), hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), hora_fim, 108) AS hora_fim,
              CONVERT(varchar(5), hora_inicio_real, 108) AS hora_inicio_real,
              CONVERT(varchar(5), hora_fim_real, 108) AS hora_fim_real,
              inicio_automatico, uso_contabilizado_minutos
       FROM Reserva WHERE id = @id`
    );
  const reserva = leitura.recordset[0];
  if (!reserva || reserva.uso_contabilizado_minutos !== null) return null;

  const minutos = calcularMinutosDeUso({
    horaInicio: reserva.hora_inicio,
    horaFim: reserva.hora_fim,
    horaInicioReal: reserva.hora_inicio_real,
    horaFimReal: reserva.hora_fim_real,
    inicioAutomatico: Boolean(reserva.inicio_automatico),
  });

  const marcacao = await transaction
    .request()
    .input("id", sql.UniqueIdentifier, reservaId)
    .input("minutos", sql.Int, minutos)
    .query(
      `UPDATE Reserva SET uso_contabilizado_minutos = @minutos
       WHERE id = @id AND uso_contabilizado_minutos IS NULL`
    );
  if (marcacao.rowsAffected[0] !== 1) return null;

  if (minutos > 0) {
    await transaction
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, reserva.plataforma_id)
      .input("minutos", sql.Int, minutos)
      .query(
        `UPDATE Plataforma SET horimetro_uso_minutos = horimetro_uso_minutos + @minutos
         WHERE id = @plataforma_id`
      );
  }
  return minutos;
}

// Início e conclusão de uso passaram a ter DOIS gatilhos — o clique do usuário
// (PATCH /reservas/:id/status) e o worker de automação — e a regra de negócio precisa ser
// exatamente a mesma nos dois. Este módulo é essa regra única: as rotas e o worker chamam
// as mesmas funções, ninguém reimplementa "pode iniciar?" por conta própria.
export type OrigemTransicao = "manual" | "automatica";

/* O gate de checklist foi REMOVIDO daqui (migration 0018): o checklist deixou de fazer
 * parte do fluxo de reserva, então nem o clique nem o relógio consultam mais o estado de
 * um checklist para decidir se a reserva pode começar. As execuções NR-18/35 já realizadas
 * continuam intactas no banco.
 *
 * As regras que PERMANECEM valendo para iniciar o uso são as do equipamento em si — ver
 * `iniciarUsoReserva`: plataforma inativa ou em manutenção continua bloqueando. */

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
  /* Só para `concluirReserva`: normalmente uma conclusão parte de 'em_uso', mas o
     sincronizador também encerra reservas cuja janela inteira passou sem uso (servidor
     fora do ar durante o período), e essas partem de 'agendada'. */
  statusDeEsperado?: StatusReserva;
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
    contabilizarUso?: boolean;
  }
): Promise<ResultadoTransicao> {
  // Horário real gravado (base do horímetro):
  //  - fim automático = o horário final AGENDADO (o job pode rodar minutos depois, ou só
  //    quando o servidor volta; o uso terminou no horário marcado);
  //  - início automático e transições manuais = o instante real, no relógio de Brasília. O
  //    job roda a cada minuto, então o início automático cai no próprio minuto agendado; se
  //    ele só puder começar depois (servidor fora do ar, reserva urgente que assumiu o
  //    horário após uma substituição), conta a partir de quando começou de fato.
  const usarHorarioAgendado = params.origem === "automatica" && params.campoHoraReal === "hora_fim_real";
  let usoContabilizado: number | null = null;
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const atualizacao = await transaction
      .request()
      .input("id", sql.UniqueIdentifier, params.reservaId)
      .input("status_de", sql.VarChar, params.statusDe)
      .input("status_para", sql.VarChar, params.statusPara)
      .input("usar_agendado", sql.Bit, usarHorarioAgendado)
      .input("hora_real", sql.VarChar, horaAtualBrasilia())
      .query<{ id: string }>(
        `UPDATE Reserva
         SET status = @status_para,
             ${params.campoHoraReal} = CASE WHEN @usar_agendado = 1 THEN hora_fim ELSE CAST(@hora_real AS TIME) END,
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
      // Automático e manual gravam ações DIFERENTES: numa auditoria, "isso foi o sistema ou
      // alguém?" é exatamente o tipo de pergunta que se faz, e o nome do evento é o lugar
      // mais direto de responder (a coluna Responsável mostra "Sistema", mas não distingue
      // um encerramento por horário de uma intervenção manual feita por um job).
      .input(
        "acao",
        sql.VarChar,
        params.origem === "automatica" ? `${params.acaoAuditoria}_automatico` : params.acaoAuditoria
      )
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

    // Horímetro: na MESMA transação da conclusão — ou a reserva conclui e contabiliza, ou
    // nenhum dos dois acontece.
    if (params.contabilizarUso) {
      usoContabilizado = await contabilizarUsoReserva(transaction, params.reservaId);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    throw err;
  }

  if (usoContabilizado !== null && usoContabilizado > 0) {
    publicarEventoGlobal("plataforma.horimetro_atualizado", { reservaId: params.reservaId, minutos: usoContabilizado });
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

export async function iniciarUsoReserva(
  params: ParametrosTransicao & { contexto: ContextoReservaTransicao }
): Promise<ResultadoTransicao> {
  // RN-PLAT-01/04: uma plataforma que entrou em manutenção/inativa depois de a reserva ser
  // agendada não pode ser colocada em uso — nem manualmente, nem pelo relógio.
  if (params.contexto.plataformaStatus === "inativa" || params.contexto.plataformaStatus === "manutencao") {
    return {
      aplicada: false,
      motivo: `Plataforma está em "${params.contexto.plataformaStatus}" e não pode iniciar uso.`,
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
    statusDe: params.statusDeEsperado ?? "em_uso",
    statusPara: "concluida",
    campoHoraReal: "hora_fim_real",
    acaoAuditoria: "concluir_reserva",
    contabilizarUso: true,
  });
}
