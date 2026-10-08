import {
  ATALHOS_DURACAO_MINUTOS,
  OFFSET_BRASILIA_MINUTOS,
  PASSO_MINUTOS_PADRAO,
  ULTIMO_MINUTO_RESERVAVEL,
  calcularIntervalosLivres,
  combinarDataHoraBrasilia,
  duracoesRapidasPermitidas,
  fimMaximoPossivel,
  formatarPeriodoReserva,
  horaParaMinutos,
  inicioDeSlotsLivres,
  intervaloCabeNosLivres,
  minutosParaHora,
  type DisponibilidadeDiaResposta,
  type FaixaMinutos,
  type IntervaloOcupadoDisponibilidade,
} from "@plataformares/shared";

// Cálculos puros da escolha de horário da "Nova Reserva". Ficam fora do componente porque
// (1) são as regras que decidem o que o usuário pode clicar — precisam ser lidas e testadas
// sem DOM — e (2) o modal e o seletor consomem o mesmo resultado (validação do botão e
// chips), então um único cálculo memoizado evita dois lugares divergindo.
//
// A aritmética de janelas vem de @plataformares/shared/disponibilidade (a mesma que a API
// usa); aqui só se combina com as regras de agenda e com a antecedência mínima. O backend
// continua sendo a autoridade: tudo aqui é para NÃO oferecer o que ele recusaria.

export type PrioridadeReserva = "normal" | "alta" | "urgente";

// ---------------------------------------------------------------------------------------
// Datas civis de Brasília
// ---------------------------------------------------------------------------------------

/**
 * Data civil (YYYY-MM-DD) em Brasília. `toISOString()` devolve a data em UTC, que já é o dia
 * seguinte a partir das 21h de Brasília — a antiga `hojeStr()` errava exatamente nesse
 * intervalo (o "hoje" do formulário virava amanhã à noite). Deslocar o instante pelo offset
 * fixo antes de ler os componentes UTC dá o relógio de parede de Brasília.
 */
export function hojeBrasilia(agora: Date = new Date()): string {
  return new Date(agora.getTime() + OFFSET_BRASILIA_MINUTOS * 60_000).toISOString().slice(0, 10);
}

export function somarDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

/** YYYY-MM-DD que existe no calendário (rejeita "2026-02-31" e o vazio do input date). */
export function dataIsoValida(data: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const [ano, mes, dia] = data.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

const DIAS_SEMANA_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "sex 18/09" — o dia da semana ajuda a conferir a data escolhida de relance. */
export function formatarDataResumo(data: string): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  const diaSemana = DIAS_SEMANA_CURTOS[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
  return `${diaSemana} ${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}`;
}

/** 60 → "1h", 90 → "1h30", 45 → "45min". */
export function formatarDuracao(minutos: number): string {
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas === 0) return `${resto}min`;
  if (resto === 0) return `${horas}h`;
  return `${horas}h${String(resto).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------
// Seleção (início + duração)
// ---------------------------------------------------------------------------------------

/**
 * O que o usuário escolheu. `duracao` numérica = atalho (1h/2h/4h); "personalizado" usa o
 * `fimPersonalizadoMin` absoluto, sempre vindo de uma lista fechada (nunca texto livre).
 */
export interface SelecaoHorario {
  inicioMin: number;
  duracao: number | "personalizado";
  fimPersonalizadoMin: number | null;
}

export function fimDaSelecao(selecao: SelecaoHorario): number | null {
  return selecao.duracao === "personalizado" ? selecao.fimPersonalizadoMin : selecao.inicioMin + selecao.duracao;
}

// ---------------------------------------------------------------------------------------
// Agenda de uma plataforma numa data
// ---------------------------------------------------------------------------------------

export interface OcupacaoExibida {
  chave: string;
  faixa: string;
  descricao: string;
  /** Solicitação ainda sem decisão: aparece na lista, mas não ocupa o horário. */
  pendente?: boolean;
}

/** Reserva CONFIRMADA (agendada/em uso) — a única que uma urgente pode sobrepor, para decisão. */
export interface ReservaConfirmadaNaAgenda extends FaixaMinutos {
  descricao: string;
}

export interface AgendaPlataforma {
  /** Janela reservável: expediente das regras, ou o dia inteiro para prioridade urgente. */
  janela: FaixaMinutos;
  /** Nenhum início antes deste minuto respeita a antecedência mínima. */
  corteMin: number;
  duracaoMaxMin: number;
  /** Trechos livres na janela, SEM o corte de antecedência (que só afeta o início). */
  livres: FaixaMinutos[];
  /** Inícios oferecidos como chip (já respeitam a antecedência mínima). */
  inicios: number[];
  ocupacoes: OcupacaoExibida[];
  /** Reservas confirmadas do dia. Para urgente elas NÃO entram em `livres`: a sobreposição é
   *  permitida na solicitação e vira decisão de substituição de Gestor/Admin. */
  reservasConfirmadas: ReservaConfirmadaNaAgenda[];
  expedienteInicio: string;
  expedienteFim: string;
}

function descreverOcupacao(intervalo: IntervaloOcupadoDisponibilidade): string {
  if (intervalo.tipo === "reserva") {
    const setor = intervalo.setorNome ?? "Reserva";
    const partes = [setor];
    if (intervalo.status === "em_uso") partes.push("em uso");
    if (intervalo.status === "pendente") partes.push("pendente de aprovação");
    return partes.join(" · ");
  }
  const base = intervalo.tipo === "bloqueio_global" ? "Bloqueio geral" : "Bloqueio da plataforma";
  return intervalo.motivo ? `${base}: ${intervalo.motivo}` : base;
}

/**
 * Cruza a consulta agregada de disponibilidade (uma por data) com a plataforma escolhida.
 * `null` = a plataforma não veio na resposta (ainda não escolhida ou removida).
 */
export function calcularAgendaPlataforma(
  dados: DisponibilidadeDiaResposta,
  plataformaId: string,
  prioridade: PrioridadeReserva,
  agora: Date
): AgendaPlataforma | null {
  const plataforma = dados.plataformas.find((p) => p.id === plataformaId);
  if (!plataforma) return null;
  const { regras } = dados;

  // RN-RES-06: fora do expediente só com prioridade urgente — para ela a janela é o dia
  // todo (até 23:59, o último HH:mm que a reserva consegue expressar).
  const janela: FaixaMinutos =
    prioridade === "urgente"
      ? { inicioMin: 0, fimMin: ULTIMO_MINUTO_RESERVAVEL }
      : {
          inicioMin: horaParaMinutos(regras.horarioExpedienteInicio),
          fimMin: Math.min(horaParaMinutos(regras.horarioExpedienteFim), ULTIMO_MINUTO_RESERVAVEL),
        };

  // Antecedência mínima REAL das regras (nada de 120 min fixo). Recalculada aqui com o
  // relógio local em vez de confiar só em `inicioMinimoMin` da resposta: o modal pode ficar
  // aberto por minutos e o corte "agora + antecedência" anda junto com o relógio. O maior
  // dos dois vence — nunca oferecemos um início que o servidor já considerou cedo demais.
  const inicioDoDia = combinarDataHoraBrasilia(dados.data, "00:00").getTime();
  // Urgência dispensa a antecedência mínima (migration 0022) — mas nunca oferece um início
  // que já passou. Tolerância de 29 min = a mesma do backend (o slot de 30 min em curso ainda
  // vale). Normal: o maior entre o corte do servidor e o local.
  const corteMin =
    prioridade === "urgente"
      ? Math.min(1440, Math.max(0, Math.floor((agora.getTime() - inicioDoDia) / 60_000) - 29))
      : Math.min(
          1440,
          Math.max(
            0,
            dados.inicioMinimoMin,
            Math.ceil((agora.getTime() + regras.antecedenciaMinimaHoras * 3_600_000 - inicioDoDia) / 60_000)
          )
        );

  // O que BLOQUEIA o horário (mesma regra do POST /reservas):
  //  - concluída é histórico e pendente é só uma solicitação: nenhuma das duas ocupa;
  //  - reserva confirmada (agendada/em uso) ocupa — exceto para URGENTE, que pode ser
  //    solicitada sobre ela (vira pendente para decisão de substituição);
  //  - bloqueio de agenda ocupa sempre: indisponibilidade técnica, urgência não passa.
  const reservasConfirmadasBrutas = plataforma.intervalos.filter(
    (i) => i.tipo === "reserva" && (i.status === "agendada" || i.status === "em_uso")
  );
  const bloqueantes = plataforma.intervalos.filter((i) =>
    i.tipo === "reserva" ? prioridade !== "urgente" && reservasConfirmadasBrutas.includes(i) : true
  );
  const livres = calcularIntervalosLivres(bloqueantes, janela);
  // Lista exibida: tudo o que existe no dia menos o histórico concluído (pendentes incluídas,
  // identificadas como tal).
  const ocupantes = plataforma.intervalos.filter((i) => !(i.tipo === "reserva" && i.status === "concluida"));
  const inicios = inicioDeSlotsLivres(livres, PASSO_MINUTOS_PADRAO, PASSO_MINUTOS_PADRAO).filter(
    (inicio) => inicio >= corteMin
  );

  return {
    janela,
    corteMin,
    duracaoMaxMin: Math.round(regras.duracaoMaximaHoras * 60),
    livres,
    inicios,
    ocupacoes: ocupantes.map((i, indice) => ({
      chave: `${i.tipo}-${i.id}-${indice}`,
      // Reserva de vários dias: o período inteiro, não o recorte "00:00–24:00" do dia.
      faixa:
        i.periodo && i.periodo.dataFim !== i.periodo.data
          ? formatarPeriodoReserva(i.periodo)
          : `${minutosParaHora(i.inicioMin)}–${minutosParaHora(i.fimMin)}`,
      descricao: descreverOcupacao(i),
      pendente: i.tipo === "reserva" && i.status === "pendente",
    })),
    reservasConfirmadas: reservasConfirmadasBrutas.map((i) => ({
      inicioMin: i.inicioMin,
      fimMin: i.fimMin,
      descricao: descreverOcupacao(i),
    })),
    expedienteInicio: regras.horarioExpedienteInicio,
    expedienteFim: regras.horarioExpedienteFim,
  };
}

/** Reservas confirmadas que a faixa [inicio, fim) sobrepõe — o aviso de substituição da urgente. */
export function conflitosComReservasConfirmadas(
  agenda: AgendaPlataforma,
  inicioMin: number,
  fimMin: number
): ReservaConfirmadaNaAgenda[] {
  return agenda.reservasConfirmadas.filter((r) => inicioMin < r.fimMin && fimMin > r.inicioMin);
}

export function fimMaximo(agenda: AgendaPlataforma, inicioMin: number): number | null {
  return fimMaximoPossivel(inicioMin, agenda.livres, agenda.duracaoMaxMin);
}

/** Atalhos 1h/2h/4h que CABEM a partir deste início. */
export function duracoesPermitidas(agenda: AgendaPlataforma, inicioMin: number): number[] {
  return duracoesRapidasPermitidas(inicioMin, agenda.livres, agenda.duracaoMaxMin, ATALHOS_DURACAO_MINUTOS);
}

/**
 * Seleção inicial para um início recém-escolhido: mantém a duração que o usuário já tinha
 * se ainda couber (trocar só o horário não deve zerar a decisão de "2h"); senão 1h; senão a
 * maior que caiba; senão o menor passo possível (30 min, ou o que sobrar).
 */
export function selecaoPadrao(
  agenda: AgendaPlataforma,
  inicioMin: number,
  anterior?: SelecaoHorario | null
): SelecaoHorario {
  const permitidas = duracoesPermitidas(agenda, inicioMin);
  if (anterior && typeof anterior.duracao === "number" && permitidas.includes(anterior.duracao)) {
    return { inicioMin, duracao: anterior.duracao, fimPersonalizadoMin: null };
  }
  // Duração personalizada (HH:mm exato, não necessariamente um dos atalhos de 30 min):
  // preserva o número de minutos exato no novo início, se ainda couber — trocar o início
  // não pode arredondar/descartar o que foi digitado.
  if (anterior && anterior.duracao === "personalizado" && anterior.fimPersonalizadoMin !== null) {
    const duracaoAnteriorMin = anterior.fimPersonalizadoMin - anterior.inicioMin;
    const fimMaxNovo = fimMaximo(agenda, inicioMin);
    if (fimMaxNovo !== null && inicioMin + duracaoAnteriorMin <= fimMaxNovo) {
      return { inicioMin, duracao: "personalizado", fimPersonalizadoMin: inicioMin + duracaoAnteriorMin };
    }
  }
  if (permitidas.includes(60)) return { inicioMin, duracao: 60, fimPersonalizadoMin: null };
  if (permitidas.length > 0) {
    return { inicioMin, duracao: permitidas[permitidas.length - 1], fimPersonalizadoMin: null };
  }
  const fimMax = fimMaximo(agenda, inicioMin) ?? inicioMin + PASSO_MINUTOS_PADRAO;
  return {
    inicioMin,
    duracao: "personalizado",
    fimPersonalizadoMin: Math.min(inicioMin + PASSO_MINUTOS_PADRAO, fimMax),
  };
}

/** Intervalo vindo de fora (clique/arraste no calendário) convertido em seleção. */
export function selecaoDeIntervalo(inicioMin: number, fimMin: number): SelecaoHorario {
  const duracao = fimMin - inicioMin;
  return (ATALHOS_DURACAO_MINUTOS as readonly number[]).includes(duracao)
    ? { inicioMin, duracao, fimPersonalizadoMin: null }
    : { inicioMin, duracao: "personalizado", fimPersonalizadoMin: fimMin };
}

/** A seleção continua cabendo na agenda atual (antecedência, expediente, ocupações, duração máxima)? */
export function selecaoValida(agenda: AgendaPlataforma, selecao: SelecaoHorario): boolean {
  const fim = fimDaSelecao(selecao);
  if (fim === null) return false;
  if (fim <= selecao.inicioMin || fim > ULTIMO_MINUTO_RESERVAVEL) return false;
  if (fim - selecao.inicioMin > agenda.duracaoMaxMin) return false;
  if (selecao.inicioMin < agenda.corteMin) return false;
  return intervaloCabeNosLivres({ inicioMin: selecao.inicioMin, fimMin: fim }, agenda.livres);
}

/** O minuto está dentro de algum trecho livre da agenda (ignora duração). */
function inicioLivre(agenda: AgendaPlataforma, inicioMin: number): boolean {
  return agenda.livres.some((l) => inicioMin >= l.inicioMin && inicioMin < l.fimMin);
}

/**
 * Horário de início digitado em "Personalizado": mesma autoridade (antecedência, expediente,
 * ocupações) que os chips e o backend já aplicam — só muda a granularidade, de 30 min para 1.
 */
export function erroInicioPersonalizado(agenda: AgendaPlataforma, inicioMin: number): string | null {
  if (inicioMin < agenda.corteMin) return "Este horário já passou ou está dentro da antecedência mínima.";
  if (!inicioLivre(agenda, inicioMin)) return "Este horário não está disponível.";
  return null;
}

/**
 * Duração digitada em "Personalizado" (HH:mm livre, além da lista de fins em passos de 30
 * min): mesmo teto que `opcoesFimPersonalizado` já respeita (duração máxima, próxima
 * ocupação, 23:59) — só sem estar preso à grade de 30 min.
 */
export function erroDuracaoPersonalizada(agenda: AgendaPlataforma, inicioMin: number, duracaoMin: number): string | null {
  if (!Number.isFinite(duracaoMin) || duracaoMin <= 0) return "Informe uma duração válida.";
  const fimMax = fimMaximo(agenda, inicioMin);
  if (fimMax === null) return "Este horário não está disponível.";
  if (inicioMin + duracaoMin > fimMax) {
    return `Duração ultrapassa o período disponível. Disponível até ${minutosParaHora(fimMax)}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Campo "Horário personalizado" — decisões puras (o componente só as executa)
// ---------------------------------------------------------------------------------------

export type DecisaoInicioDigitado =
  | { acao: "aplicar"; inicioMin: number }
  | { acao: "invalidar" }
  | { acao: "manter" };

/**
 * O que fazer com o texto do campo (HH:mm) quando ele muda ou quando a agenda é recalculada.
 * Texto vazio/incompleto ou horário inválido INVALIDA a seleção — nunca deixa valendo, por
 * baixo do que está escrito, um valor intermediário da digitação (o "10:04" que o
 * <input type="time"> emite antes do último dígito de "10:40").
 */
export function decidirInicioDigitado(
  agenda: AgendaPlataforma,
  texto: string,
  inicioSelecionadoMin: number | null
): DecisaoInicioDigitado {
  if (!/^\d{2}:\d{2}$/.test(texto) || erroInicioPersonalizado(agenda, horaParaMinutos(texto))) {
    return inicioSelecionadoMin === null ? { acao: "manter" } : { acao: "invalidar" };
  }
  const inicioMin = horaParaMinutos(texto);
  return inicioMin === inicioSelecionadoMin ? { acao: "manter" } : { acao: "aplicar", inicioMin };
}

/**
 * Texto a exibir quando a SELEÇÃO muda. `null` = não mexer no campo: a mudança veio do próprio
 * campo (`inicioEmitidoMin`) ou não há seleção. Só uma mudança externa (chip, calendário,
 * "próximo horário") reescreve o que o usuário digitou.
 */
export function textoParaSelecaoExterna(
  inicioSelecionadoMin: number | null,
  inicioEmitidoMin: number | null
): string | null {
  if (inicioSelecionadoMin === null || inicioSelecionadoMin === inicioEmitidoMin) return null;
  return minutosParaHora(inicioSelecionadoMin);
}

export interface OpcaoFim {
  fimMin: number;
  rotulo: string;
}

/**
 * Horas finais do "Personalizado": passos de 30 min a partir do início até o máximo possível
 * — e o próprio máximo quando ele não cai na grade (23:59, ou o começo da próxima reserva
 * fora dela). Lista fechada: é o que impede um fim inválido de ser digitado.
 */
export function opcoesFimPersonalizado(agenda: AgendaPlataforma, inicioMin: number): OpcaoFim[] {
  const fimMax = fimMaximo(agenda, inicioMin);
  if (fimMax === null || fimMax <= inicioMin) return [];
  const fins: number[] = [];
  for (let fim = inicioMin + PASSO_MINUTOS_PADRAO; fim <= fimMax; fim += PASSO_MINUTOS_PADRAO) fins.push(fim);
  if (fins.length === 0 || fins[fins.length - 1] < fimMax) fins.push(fimMax);
  return fins.map((fimMin) => ({
    fimMin,
    rotulo: `${minutosParaHora(fimMin)} · ${formatarDuracao(fimMin - inicioMin)}`,
  }));
}

// ---------------------------------------------------------------------------------------
// Agrupamento dos chips de início por período do dia
// ---------------------------------------------------------------------------------------

export interface GrupoPeriodo {
  rotulo: string;
  inicios: number[];
}

const PERIODOS: { rotulo: string; ateMin: number }[] = [
  { rotulo: "Madrugada", ateMin: 6 * 60 },
  { rotulo: "Manhã", ateMin: 12 * 60 },
  { rotulo: "Tarde", ateMin: 18 * 60 },
  { rotulo: "Noite", ateMin: 24 * 60 },
];

export function agruparPorPeriodo(inicios: number[]): GrupoPeriodo[] {
  const grupos: GrupoPeriodo[] = PERIODOS.map((p) => ({ rotulo: p.rotulo, inicios: [] }));
  for (const inicio of inicios) {
    const indice = PERIODOS.findIndex((p) => inicio < p.ateMin);
    grupos[indice === -1 ? grupos.length - 1 : indice].inicios.push(inicio);
  }
  return grupos.filter((g) => g.inicios.length > 0);
}
