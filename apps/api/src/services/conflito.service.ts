export interface ReservaExistente {
  id: string;
  horaInicio: string;
  horaFim: string;
}

export interface NovoHorario {
  horaInicio: string;
  horaFim: string;
  ignorarReservaId?: string;
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
  const inicioNovo = horaParaMinutos(novoHorario.horaInicio);
  const fimNovo = horaParaMinutos(novoHorario.horaFim);

  const conflito = reservasExistentes.find((reserva) => {
    if (novoHorario.ignorarReservaId && reserva.id === novoHorario.ignorarReservaId) {
      return false;
    }
    const inicioExistente = horaParaMinutos(reserva.horaInicio);
    const fimExistente = horaParaMinutos(reserva.horaFim);
    return !(fimNovo <= inicioExistente || inicioNovo >= fimExistente);
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
  horaInicio: string;
  horaFim: string;
}

export interface IntervaloDataHora {
  dataInicio: Date;
  dataFim: Date;
}

// Combina data (YYYY-MM-DD) + hora (HH:mm) em um instante único, em UTC, para poder
// comparar contra o intervalo DATETIME2 de um BloqueioAgenda. Não representa fuso
// horário real — apenas um eixo de tempo comum e consistente para a comparação.
export function combinarDataHora(data: string, hora: string): Date {
  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia, h, m));
}

function intervalosSeSobrepoe(aInicio: number, aFim: number, bInicio: number, bFim: number): boolean {
  return !(aFim <= bInicio || aInicio >= bFim);
}

export function encontrarBloqueioConflitante(
  bloqueios: BloqueioAtivo[],
  plataformaId: string,
  horario: { data: string; horaInicio: string; horaFim: string }
): BloqueioAtivo | null {
  const inicioReserva = combinarDataHora(horario.data, horario.horaInicio).getTime();
  const fimReserva = combinarDataHora(horario.data, horario.horaFim).getTime();

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
    const inicioReserva = combinarDataHora(reserva.data, reserva.horaInicio).getTime();
    const fimReserva = combinarDataHora(reserva.data, reserva.horaFim).getTime();
    return intervalosSeSobrepoe(inicioReserva, fimReserva, inicioBloqueio, fimBloqueio);
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
  // RN-RES-03: duração não pode exceder duracao_maxima_horas.
  const duracaoMinutos = horaParaMinutos(dados.horaFim) - horaParaMinutos(dados.horaInicio);
  if (duracaoMinutos > regras.duracaoMaximaHoras * 60) {
    return {
      ok: false,
      erro: `A duração da reserva não pode exceder ${regras.duracaoMaximaHoras} hora(s) (configuração do sistema).`,
    };
  }

  // RN-RES-06: fora do horário de expediente exige prioridade urgente.
  if (dados.prioridade !== "urgente") {
    const foraDoExpediente =
      horaParaMinutos(dados.horaInicio) < horaParaMinutos(regras.horarioExpedienteInicio) ||
      horaParaMinutos(dados.horaFim) > horaParaMinutos(regras.horarioExpedienteFim);
    if (foraDoExpediente) {
      return {
        ok: false,
        erro: `Reservas fora do horário de expediente (${regras.horarioExpedienteInicio}–${regras.horarioExpedienteFim}) exigem prioridade urgente.`,
      };
    }
  }

  // RN-RES-03: antecedência mínima para solicitar a reserva.
  const inicioReserva = combinarDataHora(dados.data, dados.horaInicio).getTime();
  const antecedenciaMinimaMs = regras.antecedenciaMinimaHoras * 60 * 60 * 1000;
  if (inicioReserva - agora.getTime() < antecedenciaMinimaMs) {
    return {
      ok: false,
      erro: `Reservas exigem antecedência mínima de ${regras.antecedenciaMinimaHoras} hora(s).`,
    };
  }

  return { ok: true };
}
