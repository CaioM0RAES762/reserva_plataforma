import {
  combinarDataHoraBrasilia,
  duracaoPeriodoMinutos,
  periodosSeSobrepoem,
  prioridadeEhUrgente,
  validarAntecedenciaMinima,
  type PeriodoReserva,
} from "@plataformares/shared";

/* Período com data opcional: sem `data`, o horário é tratado como do mesmo dia de referência
   (comportamento anterior à migration 0029, mantido para chamadas que só comparam horas). */
interface HorarioComDataOpcional {
  data?: string;
  dataFim?: string;
  horaInicio: string;
  horaFim: string;
}

export interface ReservaExistente extends HorarioComDataOpcional {
  id: string;
}

export interface NovoHorario extends HorarioComDataOpcional {
  ignorarReservaId?: string;
}

const DIA_REFERENCIA = "2000-01-01";

export function paraPeriodo(horario: HorarioComDataOpcional): PeriodoReserva {
  const data = horario.data ?? DIA_REFERENCIA;
  return { data, dataFim: horario.dataFim ?? data, horaInicio: horario.horaInicio, horaFim: horario.horaFim };
}

export function horaParaMinutos(hora: string): number {
  const [horas, minutos] = hora.split(":").map(Number);
  return horas * 60 + minutos;
}

export function horarioValido(horaInicio: string, horaFim: string): boolean {
  return horaParaMinutos(horaFim) > horaParaMinutos(horaInicio);
}

// RN-RES-02: NOT (fim_nova <= inicio_existente OR inicio_nova >= fim_existente).
// Adjacência exata (fim_nova == inicio_existente, ou inicio_nova == fim_existente) NÃO é conflito.
export function encontrarConflito(
  reservasExistentes: ReservaExistente[],
  novoHorario: NovoHorario
): ReservaExistente | null {
  const novo = paraPeriodo(novoHorario);
  const conflito = reservasExistentes.find((reserva) => {
    if (novoHorario.ignorarReservaId && reserva.id === novoHorario.ignorarReservaId) {
      return false;
    }
    return periodosSeSobrepoem(novo, paraPeriodo(reserva));
  });

  return conflito ?? null;
}

// S9 (RN-RES-11): bloqueio de agenda ativo (mesma plataforma OU global — plataformaId
// null) cobrindo o horário solicitado impede a criação da reserva.
export interface BloqueioAtivo {
  id: string;
  plataformaId: string | null;
  dataInicio: Date;
  dataFim: Date;
  motivo: string;
}

export interface ReservaComData {
  id: string;
  data: string;
  /** Último dia do período (migration 0029); ausente = mesmo dia de `data`. */
  dataFim?: string;
  horaInicio: string;
  horaFim: string;
}

/** Instantes UTC reais de início e fim de um período em horário de Brasília. */
export function instantesDoPeriodo(periodo: PeriodoReserva): { inicio: number; fim: number } {
  return {
    inicio: combinarDataHoraBrasilia(periodo.data, periodo.horaInicio).getTime(),
    fim: combinarDataHoraBrasilia(periodo.dataFim, periodo.horaFim).getTime(),
  };
}

export interface IntervaloDataHora {
  dataInicio: Date;
  dataFim: Date;
}

function intervalosSeSobrepoe(aInicio: number, aFim: number, bInicio: number, bFim: number): boolean {
  return !(aFim <= bInicio || aInicio >= bFim);
}

// BUG CORRIGIDO: o instante da reserva precisa ser uma conversão de fuso REAL
// (combinarDataHoraBrasilia), porque o outro lado da comparação — BloqueioAgenda.data_inicio/
// data_fim, vindo do banco — já é um instante real. Antes, este lado usava combinarDataHora
// (rotula a hora de Brasília como se já fosse UTC, sem converter), criando um desvio de 3h
// que deixava bloqueios de horário específico não pegarem reservas que colidiam de verdade
// (só bloqueios de dia inteiro "acidentalmente" continuavam funcionando). Mesma classe de
// bug já corrigida em validarJanelaReserva (ver comentário abaixo).
export function encontrarBloqueioConflitante(
  bloqueios: BloqueioAtivo[],
  plataformaId: string,
  horario: { data: string; dataFim?: string; horaInicio: string; horaFim: string }
): BloqueioAtivo | null {
  const { inicio: inicioReserva, fim: fimReserva } = instantesDoPeriodo(paraPeriodo(horario));

  const conflito = bloqueios.find((bloqueio) => {
    if (bloqueio.plataformaId !== null && bloqueio.plataformaId !== plataformaId) {
      return false;
    }
    return intervalosSeSobrepoe(
      inicioReserva,
      fimReserva,
      bloqueio.dataInicio.getTime(),
      bloqueio.dataFim.getTime()
    );
  });

  return conflito ?? null;
}

// S9 (RN-BLK-01): usado na criação de um BloqueioAgenda para achar reservas
// agendada/em_uso já existentes que colidem com o período do novo bloqueio — exige
// confirmação explícita do Admin antes de efetivar.
export function reservasDentroDoIntervalo<T extends ReservaComData>(
  reservas: T[],
  intervalo: IntervaloDataHora
): T[] {
  const inicioBloqueio = intervalo.dataInicio.getTime();
  const fimBloqueio = intervalo.dataFim.getTime();

  return reservas.filter((reserva) => {
    const { inicio, fim } = instantesDoPeriodo(paraPeriodo(reserva));
    return intervalosSeSobrepoe(inicio, fim, inicioBloqueio, fimBloqueio);
  });
}

// S12 (RF-CFG-01/02) — regras de agendamento antes inexistentes no código, agora
// configuráveis via ConfiguracaoSistema (configuracao.service.ts busca os valores;
// esta função permanece pura/testável, sem acesso a banco, recebendo os valores já
// resolvidos). `agora` é parametrizável para permitir teste determinístico.
export interface RegrasJanelaReserva {
  antecedenciaMinimaHoras: number;
  duracaoMaximaHoras: number;
  horarioExpedienteInicio: string;
  horarioExpedienteFim: string;
}

export interface DadosJanelaReserva {
  data: string;
  /** Último dia (reserva de vários dias); ausente = mesmo dia. */
  dataFim?: string;
  horaInicio: string;
  horaFim: string;
  prioridade: string;
}

export type ValidacaoJanelaResultado = { ok: true } | { ok: false; erro: string };

export function validarJanelaReserva(
  dados: DadosJanelaReserva,
  regras: RegrasJanelaReserva,
  agora: Date = new Date()
): ValidacaoJanelaResultado {
  // RN-RES-03: duração não pode exceder duracao_maxima_horas — medida do início ao fim do
  // período inteiro (uma reserva de vários dias soma as noites intermediárias).
  const duracaoMinutos = duracaoPeriodoMinutos(paraPeriodo(dados));
  if (duracaoMinutos <= 0) {
    return { ok: false, erro: "O fim da reserva deve ser depois do início." };
  }
  if (duracaoMinutos > regras.duracaoMaximaHoras * 60) {
    return {
      ok: false,
      erro: `A duração da reserva não pode exceder ${regras.duracaoMaximaHoras} hora(s) (configuração do sistema).`,
    };
  }

  // RN-RES-06: fora do horário de expediente exige prioridade urgente. Numa reserva de vários
  // dias, o INÍCIO precisa cair no expediente do primeiro dia e o FIM no expediente do último
  // (as noites intermediárias ficam reservadas — o equipamento continua com quem reservou).
  if (!prioridadeEhUrgente(dados.prioridade)) {
    const expInicio = horaParaMinutos(regras.horarioExpedienteInicio);
    const expFim = horaParaMinutos(regras.horarioExpedienteFim);
    const inicio = horaParaMinutos(dados.horaInicio);
    const fim = horaParaMinutos(dados.horaFim);
    const foraDoExpediente = inicio < expInicio || inicio >= expFim || fim <= expInicio || fim > expFim;
    if (foraDoExpediente) {
      return {
        ok: false,
        erro: `Reservas fora do horário de expediente (${regras.horarioExpedienteInicio}–${regras.horarioExpedienteFim}) exigem prioridade urgente.`,
      };
    }
  }

  // RN-RES-03: antecedência mínima para solicitar a reserva. `combinarDataHoraBrasilia`
  // faz a conversão de fuso real (Brasília → UTC), necessária porque o outro lado da
  // comparação é `agora`, um instante real (`new Date()`) — mesma conversão usada em todo
  // este arquivo agora para comparar contra BloqueioAgenda (ver encontrarBloqueioConflitante/
  // reservasDentroDoIntervalo), que também guarda instantes reais.
  const inicioReserva = combinarDataHoraBrasilia(dados.data, dados.horaInicio);

  // Urgência dispensa SÓ a antecedência mínima — nunca permite um início que já passou.
  // Todas as demais regras (duração, conflito, bloqueio, plataforma inativa, capacidade)
  // continuam valendo para ela; e urgência não é aprovação: colaborador segue PENDENTE.
  if (prioridadeEhUrgente(dados.prioridade)) {
    if (inicioReserva.getTime() < agora.getTime() - TOLERANCIA_INICIO_URGENTE_MS) {
      return { ok: false, erro: "O horário de início desta reserva urgente já passou." };
    }
    return { ok: true };
  }

  const antecedencia = validarAntecedenciaMinima(inicioReserva, agora, regras.antecedenciaMinimaHoras * 60);
  if (!antecedencia.ok) {
    return antecedencia;
  }

  return { ok: true };
}

// O formulário oferece inícios em passos de 30 min: uma urgência pedida às 16:31 para o
// slot das 16:30 ainda é "agora", não passado.
const TOLERANCIA_INICIO_URGENTE_MS = 30 * 60_000;
