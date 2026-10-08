import type { StatusReserva } from "@plataformares/shared";

/* Máquina de estados da Reserva.
 *
 * O fluxo de aprovação voltou na migration 0022 (a 0018 o havia removido, mas manteve
 * 'pendente'/'rejeitada' no banco — nada precisou ser recriado):
 *
 *     pendente ──aprovar──▶ agendada ──▶ em_uso ──▶ concluida
 *        │                     │            │
 *        └──rejeitar──▶ rejeitada          └────┴──▶ cancelada
 *
 * Quem pode executar cada ação (RBAC) é decidido nas rotas; aqui só vale "a partir de qual
 * status a ação é legal". A dupla aprovação antiga (Gestor + Admin para urgente/risco alto)
 * NÃO voltou: a regra vigente é aprovação simples por Admin ou Gestor do setor.
 */

export type AcaoReserva = "aprovar" | "rejeitar" | "iniciar_uso" | "concluir" | "cancelar";

export class TransicaoInvalidaError extends Error {
  constructor(
    public readonly statusAtual: StatusReserva,
    public readonly acao: AcaoReserva
  ) {
    super(`Não é possível executar a ação "${acao}" numa reserva com status "${statusAtual}".`);
    this.name = "TransicaoInvalidaError";
  }
}

interface RegraTransicao {
  de: readonly StatusReserva[];
  para: StatusReserva;
}

const TRANSICOES: Record<AcaoReserva, RegraTransicao> = {
  aprovar: { de: ["pendente"], para: "agendada" },
  rejeitar: { de: ["pendente"], para: "rejeitada" },
  iniciar_uso: { de: ["agendada"], para: "em_uso" },
  concluir: { de: ["em_uso"], para: "concluida" },
  cancelar: { de: ["pendente", "agendada", "em_uso"], para: "cancelada" },
};

export function transicionar(statusAtual: StatusReserva, acao: AcaoReserva): StatusReserva {
  const regra = TRANSICOES[acao];
  if (!regra.de.includes(statusAtual)) {
    throw new TransicaoInvalidaError(statusAtual, acao);
  }
  return regra.para;
}

/** RN-RES-04: estados terminais são somente leitura. */
export function estadoFinal(status: StatusReserva): boolean {
  return status === "concluida" || status === "cancelada" || status === "rejeitada";
}

/**
 * Uma reserva cuja janela inteira já passou sem nunca ter entrado em uso não deveria
 * permanecer "agendada" para sempre — é o caso de o servidor ter ficado fora do ar
 * durante toda a janela. Ver `processarAutomacaoReservas`.
 */
export function janelaTotalmenteVencida(
  reserva: { data: string; dataFim?: string; horaFim: string },
  agora: { data: string; hora: string }
): boolean {
  // A janela termina no ÚLTIMO dia do período (reserva de vários dias, migration 0029).
  const ultimoDia = reserva.dataFim ?? reserva.data;
  if (ultimoDia < agora.data) return true;
  return ultimoDia === agora.data && reserva.horaFim <= agora.hora;
}
