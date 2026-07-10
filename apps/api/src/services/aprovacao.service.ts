import type { PrioridadeReserva, RiscoPlataforma, StatusReserva } from "@plataformares/shared";

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

// Máquina de estados da Reserva (SDD §8.1). Sem checklist/dupla aprovação — entram em S7/S8.
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

// RN-RES-04: concluida, cancelada e rejeitada são finais e somente leitura.
export function estadoFinal(status: StatusReserva): boolean {
  return status === "concluida" || status === "cancelada" || status === "rejeitada";
}

// ==== S7 — Aprovação simples/dupla (RN-RES-07/08) ====

export class AprovacaoJaRealizadaError extends Error {
  constructor() {
    super(
      "Esta reserva já recebeu a primeira aprovação (Gestor de Setor) e aguarda a segunda aprovação do Admin."
    );
    this.name = "AprovacaoJaRealizadaError";
  }
}

export type PerfilAprovador = "admin" | "gestor_setor";
export type CampoAprovacao = "aprovado_por_id" | "segunda_aprovacao_por_id";

// RN-RES-08: reserva urgente OU plataforma de risco alto exige dupla aprovação
// (Gestor de Setor + Admin). Qualquer outra combinação é aprovação simples.
export function exigeDuplaAprovacao(prioridade: PrioridadeReserva, risco: RiscoPlataforma): boolean {
  return prioridade === "urgente" || risco === "alto";
}

export interface ContextoAprovacao {
  statusAtual: StatusReserva;
  prioridade: PrioridadeReserva;
  risco: RiscoPlataforma;
  aprovadoPorId: string | null;
}

export interface ResultadoAprovacao {
  novoStatus: StatusReserva;
  campo: CampoAprovacao;
}

// RN-RES-07/08 — decide o efeito de uma aprovação conforme o perfil de quem aprova e o
// estado atual da reserva:
// - Gestor de Setor, caso simples: aprova sozinho -> agendada.
// - Gestor de Setor, caso dupla: dá a primeira aprovação -> permanece pendente
//   (grava aprovado_por_id), aguardando o Admin.
// - Admin: aprova sempre -> agendada; se já havia aprovação do Gestor num caso de
//   dupla, grava a segunda aprovação num campo separado (segunda_aprovacao_por_id);
//   caso contrário (aprovação direta, sem esperar o Gestor), grava aprovado_por_id.
export function decidirAprovacao(
  perfil: PerfilAprovador,
  ctx: ContextoAprovacao
): ResultadoAprovacao {
  if (ctx.statusAtual !== "pendente") {
    throw new TransicaoInvalidaError(ctx.statusAtual, "aprovar");
  }

  const dupla = exigeDuplaAprovacao(ctx.prioridade, ctx.risco);

  if (perfil === "gestor_setor") {
    if (!dupla) {
      return { novoStatus: "agendada", campo: "aprovado_por_id" };
    }
    if (ctx.aprovadoPorId) {
      throw new AprovacaoJaRealizadaError();
    }
    return { novoStatus: "pendente", campo: "aprovado_por_id" };
  }

  // perfil === "admin"
  if (dupla && ctx.aprovadoPorId) {
    return { novoStatus: "agendada", campo: "segunda_aprovacao_por_id" };
  }
  return { novoStatus: "agendada", campo: "aprovado_por_id" };
}
