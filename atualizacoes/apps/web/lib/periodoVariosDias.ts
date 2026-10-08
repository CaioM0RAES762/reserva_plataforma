import {
  combinarDataHoraBrasilia,
  duracaoPeriodoMinutos,
  formatarDuracaoPeriodo,
  horaParaMinutos,
  type PeriodoReserva,
  type RegrasAgendaPublicas,
} from "@plataformares/shared";

// Validação LOCAL de uma reserva de vários dias (migration 0029) — os mesmos critérios que a
// API aplica em validarJanelaReserva/criarReservaSchema, para o formulário marcar o campo
// certo antes do envio. A API continua sendo a autoridade (e checa conflito/bloqueio).

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// Mesma tolerância do backend para início de urgente ("o slot de 30 min em curso ainda vale").
const TOLERANCIA_URGENTE_MS = 30 * 60_000;
const SEMANA_MIN = 7 * 24 * 60;

export interface ErrosPeriodo {
  horaInicio?: string;
  dataFim?: string;
  horaFim?: string;
  /** Erro que não pertence a um campo só (ex.: recorrência). */
  geral?: string;
}

export interface ResultadoPeriodo {
  erros: ErrosPeriodo;
  /** Primeira mensagem, na ordem dos campos — vira o texto ao lado do botão desabilitado. */
  primeiroErro: string | null;
  duracaoMinutos: number;
  atravessaDias: boolean;
}

export function validarPeriodoVariosDias(params: {
  periodo: PeriodoReserva;
  regras: Pick<
    RegrasAgendaPublicas,
    "antecedenciaMinimaHoras" | "duracaoMaximaHoras" | "horarioExpedienteInicio" | "horarioExpedienteFim"
  >;
  urgente: boolean;
  repetirSemanalmente: boolean;
  agora: Date;
}): ResultadoPeriodo {
  const { periodo, regras, urgente, repetirSemanalmente, agora } = params;
  const erros: ErrosPeriodo = {};
  const horaInicioOk = HORA_REGEX.test(periodo.horaInicio);
  const horaFimOk = HORA_REGEX.test(periodo.horaFim);
  const dataFimOk = DATA_REGEX.test(periodo.dataFim);

  if (!horaInicioOk) erros.horaInicio = "Informe o horário de início.";
  if (!dataFimOk) erros.dataFim = "Informe a data final.";
  else if (periodo.dataFim < periodo.data) erros.dataFim = "A data final não pode ser anterior à data inicial.";
  if (!horaFimOk) erros.horaFim = "Informe o horário final.";

  let duracaoMinutos = 0;
  if (horaInicioOk && horaFimOk && dataFimOk && !erros.dataFim) {
    duracaoMinutos = duracaoPeriodoMinutos(periodo);
    const limiteMin = regras.duracaoMaximaHoras * 60;
    if (duracaoMinutos <= 0) {
      erros.horaFim = "O fim precisa ser depois do início.";
    } else if (duracaoMinutos > limiteMin) {
      // O equivalente em dias só ajuda quando o limite passa de um dia ("170h (7 dias e 2h)").
      const limiteEmDias = regras.duracaoMaximaHoras > 24 ? ` (${formatarDuracaoPeriodo(limiteMin)})` : "";
      erros.horaFim = `Duração de ${formatarDuracaoPeriodo(duracaoMinutos)} passa do limite de ${regras.duracaoMaximaHoras}h${limiteEmDias}.`;
    }

    if (!urgente) {
      const expInicio = horaParaMinutos(regras.horarioExpedienteInicio);
      const expFim = horaParaMinutos(regras.horarioExpedienteFim);
      const inicio = horaParaMinutos(periodo.horaInicio);
      const fim = horaParaMinutos(periodo.horaFim);
      const faixa = `${regras.horarioExpedienteInicio}–${regras.horarioExpedienteFim}`;
      if (!erros.horaInicio && (inicio < expInicio || inicio >= expFim)) {
        erros.horaInicio = `O início precisa estar no expediente (${faixa}). Fora dele, só com prioridade urgente.`;
      }
      if (!erros.horaFim && (fim <= expInicio || fim > expFim)) {
        erros.horaFim = `O fim precisa estar no expediente (${faixa}). Fora dele, só com prioridade urgente.`;
      }
    }

    const inicioMs = combinarDataHoraBrasilia(periodo.data, periodo.horaInicio).getTime();
    if (!erros.horaInicio) {
      if (urgente) {
        if (inicioMs < agora.getTime() - TOLERANCIA_URGENTE_MS) erros.horaInicio = "Esse início já passou.";
      } else if (inicioMs < agora.getTime() + regras.antecedenciaMinimaHoras * 3_600_000) {
        erros.horaInicio = `O início precisa ter pelo menos ${regras.antecedenciaMinimaHoras}h de antecedência.`;
      }
    }

    if (repetirSemanalmente && duracaoMinutos >= SEMANA_MIN) {
      erros.geral = "Repetição semanal só é possível com duração menor que 7 dias — as ocorrências se sobreporiam.";
    }
  }

  const primeiroErro = erros.horaInicio ?? erros.dataFim ?? erros.horaFim ?? erros.geral ?? null;
  return { erros, primeiroErro, duracaoMinutos, atravessaDias: periodo.dataFim > periodo.data };
}
