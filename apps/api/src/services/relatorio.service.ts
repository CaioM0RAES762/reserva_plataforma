import {
  combinarDataHoraBrasilia,
  type CategoriaPlataforma,
  type StatusNaoConformidade,
  type StatusReserva,
} from "@plataformares/shared";
import { horaParaMinutos } from "./conflito.service.js";

// SDD §6.7 (RF-REL-01..05) — este módulo separa cálculo puro (testável com fixture,
// sem I/O) da consulta SQL que alimenta cada função: routes/relatorios.ts busca as
// linhas cruas do banco e repassa para as funções abaixo, que fazem a agregação.

export interface PeriodoRelatorio {
  dateFrom: string; // YYYY-MM-DD, inclusivo
  dateTo: string; // YYYY-MM-DD, inclusivo
}

// BUG CORRIGIDO: os limites do período (e os instantes de reserva abaixo) precisam ser
// conversões de fuso REAIS (combinarDataHoraBrasilia), porque são comparados contra
// BloqueioIntervalo.dataInicio/dataFim, que vêm crus do banco (instantes reais). A
// combinarDataHora antiga (rotula a hora de Brasília como se já fosse UTC) deixava a
// dedução de horas bloqueadas do relatório de utilização ~3h fora do lugar — mesma classe
// de bug corrigida em conflito.service.ts.
function inicioPeriodo(periodo: PeriodoRelatorio): Date {
  return combinarDataHoraBrasilia(periodo.dateFrom, "00:00");
}

// Limite EXCLUSIVO do período (00:00 do dia seguinte a dateTo) — dateTo é inclusivo.
function fimPeriodoExclusivo(periodo: PeriodoRelatorio): Date {
  const fim = combinarDataHoraBrasilia(periodo.dateTo, "00:00");
  fim.setUTCDate(fim.getUTCDate() + 1);
  return fim;
}

function horasNoPeriodo(periodo: PeriodoRelatorio): number {
  const ms = fimPeriodoExclusivo(periodo).getTime() - inicioPeriodo(periodo).getTime();
  return ms / (60 * 60 * 1000);
}

const MS_POR_HORA = 60 * 60 * 1000;

// Lista de dias (YYYY-MM-DD) de dateFrom a dateTo, inclusive — usada por evolução diária
// (RF-REL, PARTE 14) e tendência de bloqueios (PARTE 18) para que todo dia do período
// apareça no gráfico mesmo sem nenhum registro (eixo estável, mesmo espírito de
// contarPorChave abaixo). Aritmética de calendário pura (Date.UTC só como calculadora de
// datas) — não representa um instante real, então não tem relação com o bug de fuso já
// corrigido nas comparações contra BloqueioAgenda.
function diasDoPeriodo(periodo: PeriodoRelatorio): string[] {
  const dias: string[] = [];
  const [anoIni, mesIni, diaIni] = periodo.dateFrom.split("-").map(Number);
  const [anoFim, mesFim, diaFim] = periodo.dateTo.split("-").map(Number);
  const fimMs = Date.UTC(anoFim, mesFim - 1, diaFim);
  let cursor = Date.UTC(anoIni, mesIni - 1, diaIni);
  while (cursor <= fimMs) {
    const d = new Date(cursor);
    dias.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    );
    cursor += 24 * 60 * 60 * 1000;
  }
  return dias;
}

// ---------------------------------------------------------------------------
// RF-REL-01 — Taxa de utilização por plataforma
// ---------------------------------------------------------------------------

export interface ReservaDuracao {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  status: StatusReserva;
}

export interface BloqueioIntervalo {
  plataformaId: string | null; // null = bloqueio global (afeta todas as plataformas)
  dataInicio: Date;
  dataFim: Date;
}

export interface PlataformaResumo {
  id: string;
  codigo: string;
  nome: string;
  categoria: CategoriaPlataforma;
}

export interface UtilizacaoPlataformaCalculada {
  plataformaId: string;
  codigo: string;
  nome: string;
  categoria: CategoriaPlataforma;
  horasDisponiveis: number;
  horasReservadas: number;
  taxaUtilizacao: number;
}

const STATUS_OCUPACAO: ReadonlySet<StatusReserva> = new Set(["agendada", "em_uso", "concluida"]);

function arredondar(valor: number, casas = 2): number {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

// Clipa [inicio, fim) ao período e retorna a duração em horas (0 se não houver
// sobreposição alguma).
function horasClipadasAoPeriodo(inicio: Date, fim: Date, periodo: PeriodoRelatorio): number {
  const inicioClip = Math.max(inicio.getTime(), inicioPeriodo(periodo).getTime());
  const fimClip = Math.min(fim.getTime(), fimPeriodoExclusivo(periodo).getTime());
  return fimClip > inicioClip ? (fimClip - inicioClip) / (60 * 60 * 1000) : 0;
}

// União de intervalos (já clipados ao período) para não contar duas vezes horas
// cobertas por bloqueios sobrepostos entre si (ex.: um bloqueio global e um específico
// da mesma plataforma no mesmo intervalo).
function horasUniaoDeIntervalos(intervalos: Array<{ inicio: number; fim: number }>): number {
  if (intervalos.length === 0) return 0;
  const ordenados = [...intervalos].sort((a, b) => a.inicio - b.inicio);
  let totalMs = 0;
  let [inicioAtual, fimAtual] = [ordenados[0].inicio, ordenados[0].fim];
  for (const { inicio, fim } of ordenados.slice(1)) {
    if (inicio <= fimAtual) {
      fimAtual = Math.max(fimAtual, fim);
    } else {
      totalMs += fimAtual - inicioAtual;
      [inicioAtual, fimAtual] = [inicio, fim];
    }
  }
  totalMs += fimAtual - inicioAtual;
  return totalMs / (60 * 60 * 1000);
}

// RF-REL-01: % do tempo em reservas agendada/em_uso/concluida sobre o tempo total
// disponível no período (tempo total do período MENOS horas cobertas por bloqueios de
// agenda de S9 — RN-RES-11/RN-BLK-01), por plataforma.
export function calcularUtilizacaoPlataformas(
  plataformas: PlataformaResumo[],
  reservas: ReservaDuracao[],
  bloqueios: BloqueioIntervalo[],
  periodo: PeriodoRelatorio
): UtilizacaoPlataformaCalculada[] {
  const totalHorasPeriodo = horasNoPeriodo(periodo);

  return plataformas.map((plataforma) => {
    const bloqueiosDaPlataforma = bloqueios
      .filter((b) => b.plataformaId === null || b.plataformaId === plataforma.id)
      .map((b) => ({
        inicio: Math.max(b.dataInicio.getTime(), inicioPeriodo(periodo).getTime()),
        fim: Math.min(b.dataFim.getTime(), fimPeriodoExclusivo(periodo).getTime()),
      }))
      .filter((b) => b.fim > b.inicio);
    const horasBloqueadas = horasUniaoDeIntervalos(bloqueiosDaPlataforma);
    const horasDisponiveis = Math.max(0, totalHorasPeriodo - horasBloqueadas);

    const horasReservadas = reservas
      .filter((r) => r.plataformaId === plataforma.id && STATUS_OCUPACAO.has(r.status))
      .reduce((soma, r) => {
        const inicio = combinarDataHoraBrasilia(r.data, r.horaInicio);
        const fim = combinarDataHoraBrasilia(r.data, r.horaFim);
        return soma + horasClipadasAoPeriodo(inicio, fim, periodo);
      }, 0);

    const taxaUtilizacao = horasDisponiveis > 0 ? arredondar((horasReservadas / horasDisponiveis) * 100) : 0;

    return {
      plataformaId: plataforma.id,
      codigo: plataforma.codigo,
      nome: plataforma.nome,
      categoria: plataforma.categoria,
      horasDisponiveis: arredondar(horasDisponiveis),
      horasReservadas: arredondar(horasReservadas),
      taxaUtilizacao,
    };
  });
}

// ---------------------------------------------------------------------------
// RF-REL-02 — Ranking de setores por volume e taxa de rejeição
// ---------------------------------------------------------------------------

export interface SetorResumo {
  id: string;
  nome: string;
  corHex: string;
}

export interface RankingSetorCalculado {
  setorId: string;
  setorNome: string;
  corHex: string;
  totalReservas: number;
  totalRejeitadas: number;
  taxaRejeicao: number;
}

export function calcularRankingSetores(
  setores: SetorResumo[],
  reservas: Array<{ setorId: string; status: StatusReserva }>
): RankingSetorCalculado[] {
  const resultado = setores.map((setor) => {
    const doSetor = reservas.filter((r) => r.setorId === setor.id);
    const totalReservas = doSetor.length;
    const totalRejeitadas = doSetor.filter((r) => r.status === "rejeitada").length;
    const taxaRejeicao = totalReservas > 0 ? arredondar((totalRejeitadas / totalReservas) * 100) : 0;
    return {
      setorId: setor.id,
      setorNome: setor.nome,
      corHex: setor.corHex,
      totalReservas,
      totalRejeitadas,
      taxaRejeicao,
    };
  });

  return resultado.sort((a, b) => b.totalReservas - a.totalReservas);
}

// ---------------------------------------------------------------------------
// RF-REL-03 — Tempo médio de aprovação + distribuição por status
// ---------------------------------------------------------------------------

export interface DecisaoAprovacao {
  criadoEm: Date;
  decididoEm: Date;
}

// RF-REL-03: diferença entre Reserva.criado_em e o momento da decisão final
// (aprovação/rejeição — a ÚLTIMA de "aprovar_reserva"/"rejeitar_reserva" em
// LogAuditoria para aquela reserva, cobrindo o caso de dupla aprovação da S7), em horas.
export function calcularTempoMedioAprovacaoHoras(decisoes: DecisaoAprovacao[]): number | null {
  if (decisoes.length === 0) return null;
  const totalHoras = decisoes.reduce((soma, d) => {
    const horas = (d.decididoEm.getTime() - d.criadoEm.getTime()) / (60 * 60 * 1000);
    return soma + horas;
  }, 0);
  return arredondar(totalHoras / decisoes.length);
}

export interface ItemDistribuicao {
  chave: string;
  quantidade: number;
}

// Conta ocorrências de `valores` respeitando a ordem (e o conjunto completo) de
// `ordemChaves` — inclui chaves com quantidade 0, para que gráficos/tabelas tenham
// sempre o mesmo eixo, e para que os testes possam comparar a lista inteira com toEqual.
export function contarPorChave<T extends string>(valores: T[], ordemChaves: readonly T[]): ItemDistribuicao[] {
  const contagem = new Map<string, number>(ordemChaves.map((chave) => [chave, 0]));
  for (const valor of valores) {
    contagem.set(valor, (contagem.get(valor) ?? 0) + 1);
  }
  return ordemChaves.map((chave) => ({ chave, quantidade: contagem.get(chave) ?? 0 }));
}

// ---------------------------------------------------------------------------
// RF-REL-04 — Tendência mensal de reservas
// ---------------------------------------------------------------------------

export interface ItemTendenciaMensal {
  mes: string; // YYYY-MM
  quantidade: number;
}

// RF-REL-04: contagem de reservas por mês de criação, em ordem cronológica ascendente
// (só os meses com pelo menos uma reserva aparecem — diferente de contarPorChave, aqui
// não há um conjunto fixo de chaves possíveis).
export function calcularTendenciaMensal(datasCriacao: Date[]): ItemTendenciaMensal[] {
  const contagem = new Map<string, number>();
  for (const data of datasCriacao) {
    const mes = `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, "0")}`;
    contagem.set(mes, (contagem.get(mes) ?? 0) + 1);
  }
  return [...contagem.entries()]
    .sort(([mesA], [mesB]) => (mesA < mesB ? -1 : mesA > mesB ? 1 : 0))
    .map(([mes, quantidade]) => ({ mes, quantidade }));
}

// ---------------------------------------------------------------------------
// RF-REL-05 — Indicadores de segurança
// ---------------------------------------------------------------------------

export interface ChecklistResumo {
  todosConformes: boolean;
}

export interface OcorrenciaResumo {
  plataformaId: string;
  plataformaNome: string;
  gravidade: "baixa" | "media" | "alta";
}

export interface OcorrenciasPorPlataformaCalculada {
  plataformaId: string;
  plataformaNome: string;
  baixa: number;
  media: number;
  alta: number;
  total: number;
}

export interface IndicadoresSegurancaCalculados {
  totalChecklists: number;
  totalChecklistsNaoConformes: number;
  percentualChecklistNaoConforme: number;
  ocorrenciasPorPlataforma: OcorrenciasPorPlataformaCalculada[];
}

// RF-REL-05: % de checklists com pelo menos um item não conforme (todos_conformes = 0,
// RN-CHK-02) e número de ocorrências (S11) por plataforma, por gravidade.
export function calcularIndicadoresSeguranca(
  checklists: ChecklistResumo[],
  ocorrencias: OcorrenciaResumo[]
): IndicadoresSegurancaCalculados {
  const totalChecklists = checklists.length;
  const totalChecklistsNaoConformes = checklists.filter((c) => !c.todosConformes).length;
  const percentualChecklistNaoConforme =
    totalChecklists > 0 ? arredondar((totalChecklistsNaoConformes / totalChecklists) * 100) : 0;

  const porPlataforma = new Map<string, OcorrenciasPorPlataformaCalculada>();
  for (const ocorrencia of ocorrencias) {
    const existente = porPlataforma.get(ocorrencia.plataformaId) ?? {
      plataformaId: ocorrencia.plataformaId,
      plataformaNome: ocorrencia.plataformaNome,
      baixa: 0,
      media: 0,
      alta: 0,
      total: 0,
    };
    existente[ocorrencia.gravidade] += 1;
    existente.total += 1;
    porPlataforma.set(ocorrencia.plataformaId, existente);
  }

  return {
    totalChecklists,
    totalChecklistsNaoConformes,
    percentualChecklistNaoConforme,
    ocorrenciasPorPlataforma: [...porPlataforma.values()].sort((a, b) => b.total - a.total),
  };
}

// Reexportado por conveniência de quem monta a janela de tempo para as queries SQL
// (routes/relatorios.ts) a partir do mesmo par [inicio, fimExclusivo) usado aqui.
export function janelaSqlDoPeriodo(periodo: PeriodoRelatorio): { inicio: Date; fimExclusivo: Date } {
  return { inicio: inicioPeriodo(periodo), fimExclusivo: fimPeriodoExclusivo(periodo) };
}

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/operacional
// (Visão Geral + Uso da Frota: totais do período, evolução diária, horários de maior
// demanda, ranking de plataformas mais reservadas — PARTE 11/14/16/17)
// ---------------------------------------------------------------------------

export interface ReservaOperacional {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  status: StatusReserva;
}

function horasDaReserva(r: ReservaOperacional): number {
  return (horaParaMinutos(r.horaFim) - horaParaMinutos(r.horaInicio)) / 60;
}

export interface TotaisOperacionaisCalculados {
  totalReservas: number;
  horasReservadasTotais: number;
  totalCanceladas: number;
  taxaCancelamento: number;
}

// PARTE 11: total de reservas conta TODA reserva do período, qualquer status (é "quantas
// foram solicitadas"); horas reservadas totais só soma as que ocupam a plataforma de fato
// (mesmo STATUS_OCUPACAO usado em RF-REL-01); taxa de cancelamento é sobre o total.
export function calcularTotaisOperacionais(reservas: ReservaOperacional[]): TotaisOperacionaisCalculados {
  const totalReservas = reservas.length;
  const totalCanceladas = reservas.filter((r) => r.status === "cancelada").length;
  const horasReservadasTotais = arredondar(
    reservas.filter((r) => STATUS_OCUPACAO.has(r.status)).reduce((soma, r) => soma + horasDaReserva(r), 0)
  );
  const taxaCancelamento = totalReservas > 0 ? arredondar((totalCanceladas / totalReservas) * 100) : 0;
  return { totalReservas, horasReservadasTotais, totalCanceladas, taxaCancelamento };
}

export interface EvolucaoDiariaCalculada {
  data: string;
  quantidadeReservas: number;
  horasReservadas: number;
}

// PARTE 14: evolução diária (não só mensal) — todo dia do período aparece, mesmo sem
// reserva alguma, para o gráfico ter um eixo estável.
export function calcularEvolucaoDiaria(
  reservas: ReservaOperacional[],
  periodo: PeriodoRelatorio
): EvolucaoDiariaCalculada[] {
  const porDia = new Map<string, { quantidade: number; horas: number }>();
  for (const dia of diasDoPeriodo(periodo)) porDia.set(dia, { quantidade: 0, horas: 0 });
  for (const r of reservas) {
    const atual = porDia.get(r.data);
    if (!atual) continue;
    atual.quantidade += 1;
    if (STATUS_OCUPACAO.has(r.status)) atual.horas += horasDaReserva(r);
  }
  return [...porDia.entries()].map(([data, v]) => ({
    data,
    quantidadeReservas: v.quantidade,
    horasReservadas: arredondar(v.horas),
  }));
}

export interface DemandaPorHoraCalculada {
  hora: number;
  quantidade: number;
}

// PARTE 16: para cada reserva que ocupa a plataforma, soma +1 em cada hora civil coberta
// pelo intervalo [horaInicio, horaFim) — identifica horários de pico/gargalo.
export function calcularDemandaPorHora(reservas: ReservaOperacional[]): DemandaPorHoraCalculada[] {
  const contagem = new Array(24).fill(0) as number[];
  for (const r of reservas) {
    if (!STATUS_OCUPACAO.has(r.status)) continue;
    const horaIni = Math.floor(horaParaMinutos(r.horaInicio) / 60);
    const horaFimExclusiva = Math.ceil(horaParaMinutos(r.horaFim) / 60);
    for (let h = Math.max(0, horaIni); h < Math.min(24, horaFimExclusiva); h++) {
      contagem[h] += 1;
    }
  }
  return contagem.map((quantidade, hora) => ({ hora, quantidade }));
}

export interface RankingPlataformaCalculada {
  plataformaId: string;
  codigo: string;
  nome: string;
  totalReservas: number;
  horasReservadas: number;
}

// PARTE 17: ranking de plataformas mais reservadas (quantidade + horas), só plataformas
// com pelo menos uma reserva no período aparecem.
export function calcularRankingPlataformas(
  plataformas: PlataformaResumo[],
  reservas: ReservaOperacional[]
): RankingPlataformaCalculada[] {
  return plataformas
    .map((p) => {
      const doPlataforma = reservas.filter((r) => r.plataformaId === p.id && STATUS_OCUPACAO.has(r.status));
      return {
        plataformaId: p.id,
        codigo: p.codigo,
        nome: p.nome,
        totalReservas: doPlataforma.length,
        horasReservadas: arredondar(doPlataforma.reduce((soma, r) => soma + horasDaReserva(r), 0)),
      };
    })
    .filter((p) => p.totalReservas > 0)
    .sort((a, b) => b.totalReservas - a.totalReservas || b.horasReservadas - a.horasReservadas);
}

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/bloqueios (Indisponibilidade —
// PARTE 18)
// ---------------------------------------------------------------------------

export interface BloqueioComMotivo {
  plataformaId: string | null;
  dataInicio: Date;
  dataFim: Date;
  motivo: string;
}

export interface MotivoBloqueioCalculado {
  motivo: string;
  horasBloqueadas: number;
  ocorrencias: number;
}

export interface TendenciaBloqueioCalculada {
  data: string;
  horasBloqueadas: number;
}

export interface IndicadoresBloqueiosCalculados {
  horasBloqueadasTotais: number;
  totalBloqueios: number;
  porMotivo: MotivoBloqueioCalculado[];
  tendencia: TendenciaBloqueioCalculada[];
}

// Soma as durações de CADA bloqueio (clipadas ao período), sem deduplicar sobreposições
// entre bloqueios diferentes — diferente de RF-REL-01 (que dedup para não descontar duas
// vezes a disponibilidade de UMA plataforma), aqui o objetivo é "quantas horas de bloqueio
// foram registradas" no total, métrica distinta e documentada como tal (não é "quanto
// tempo a frota inteira ficou indisponível").
export function calcularIndicadoresBloqueios(
  bloqueios: BloqueioComMotivo[],
  periodo: PeriodoRelatorio
): IndicadoresBloqueiosCalculados {
  const inicioP = inicioPeriodo(periodo).getTime();
  const fimP = fimPeriodoExclusivo(periodo).getTime();

  const clipados = bloqueios
    .map((b) => ({
      motivo: b.motivo,
      inicio: Math.max(b.dataInicio.getTime(), inicioP),
      fim: Math.min(b.dataFim.getTime(), fimP),
    }))
    .filter((b) => b.fim > b.inicio);

  const horasBloqueadasTotais = arredondar(clipados.reduce((soma, b) => soma + (b.fim - b.inicio) / MS_POR_HORA, 0));

  const porMotivoMapa = new Map<string, { horas: number; ocorrencias: number }>();
  for (const b of clipados) {
    const atual = porMotivoMapa.get(b.motivo) ?? { horas: 0, ocorrencias: 0 };
    atual.horas += (b.fim - b.inicio) / MS_POR_HORA;
    atual.ocorrencias += 1;
    porMotivoMapa.set(b.motivo, atual);
  }
  const porMotivo = [...porMotivoMapa.entries()]
    .map(([motivo, v]) => ({ motivo, horasBloqueadas: arredondar(v.horas), ocorrencias: v.ocorrencias }))
    .sort((a, b) => b.horasBloqueadas - a.horasBloqueadas);

  const tendencia = diasDoPeriodo(periodo).map((dia) => {
    const inicioDia = combinarDataHoraBrasilia(dia, "00:00").getTime();
    const fimDia = inicioDia + 24 * MS_POR_HORA;
    const horas = clipados.reduce((soma, b) => {
      const ini = Math.max(b.inicio, inicioDia);
      const fim = Math.min(b.fim, fimDia);
      return soma + (fim > ini ? (fim - ini) / MS_POR_HORA : 0);
    }, 0);
    return { data: dia, horasBloqueadas: arredondar(horas) };
  });

  return { horasBloqueadasTotais, totalBloqueios: bloqueios.length, porMotivo, tendencia };
}

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/checklists (Segurança &
// Checklists — PARTE 19-26)
// ---------------------------------------------------------------------------

export interface ChecklistFinalizado {
  plataformaId: string;
  plataformaNome: string;
  categoria: CategoriaPlataforma;
  setorId: string;
  setorNome: string;
  finalizadoEm: Date;
  todosConformes: boolean;
  // Primeiro registro em LogAuditoria (salvar_rascunho_checklist/finalizar_checklist)
  // para a reserva — proxy de "início", já que ChecklistPreenchido.preenchido_em é
  // sobrescrito a cada salvamento. null quando não há esse registro (dado histórico
  // incompleto) — nesse caso o checklist é excluído do tempo médio, não estimado.
  inicioEm: Date | null;
}

export interface RespostaNaoConformeResumo {
  itemDescricao: string;
}

export interface ReservaChecklistResumo {
  status: StatusReserva;
  requerChecklist: boolean;
  checklistFinalizado: boolean;
}

export interface TaxasChecklistCalculadas {
  totalExigidos: number;
  totalConcluidos: number;
  taxaConclusao: number;
  totalConformes: number;
  totalNaoConformes: number;
  taxaConformidade: number;
}

// PARTE 19: taxa de conclusão sobre o universo aplicável (reservas cujo checklist era
// exigido no período — não sobre todo ChecklistPreenchido existente); taxa de
// conformidade só sobre os concluídos (um checklist não finalizado não tem veredito).
export function calcularTaxasChecklist(
  totalExigidos: number,
  finalizados: ChecklistFinalizado[]
): TaxasChecklistCalculadas {
  const totalConcluidos = finalizados.length;
  const taxaConclusao = totalExigidos > 0 ? arredondar((totalConcluidos / totalExigidos) * 100) : 0;
  const totalConformes = finalizados.filter((f) => f.todosConformes).length;
  const totalNaoConformes = totalConcluidos - totalConformes;
  const taxaConformidade = totalConcluidos > 0 ? arredondar((totalConformes / totalConcluidos) * 100) : 0;
  return { totalExigidos, totalConcluidos, taxaConclusao, totalConformes, totalNaoConformes, taxaConformidade };
}

// PARTE 25: tempo médio de conclusão — mesmo padrão de calcularTempoMedioAprovacaoHoras
// (criado_em → decidido_em), aqui inicioEm (1º registro de auditoria do checklist) →
// finalizado_em. Só entram checklists com inicioEm conhecido.
export function calcularTempoMedioConclusaoChecklistHoras(finalizados: ChecklistFinalizado[]): number | null {
  const comInicio = finalizados.filter((f): f is ChecklistFinalizado & { inicioEm: Date } => f.inicioEm !== null);
  if (comInicio.length === 0) return null;
  const total = comInicio.reduce((soma, f) => soma + (f.finalizadoEm.getTime() - f.inicioEm.getTime()) / MS_POR_HORA, 0);
  return arredondar(total / comInicio.length);
}

// Segunda-feira (YYYY-MM-DD) da semana ISO de `data` — rótulo estável para agrupar por
// semana independente do dia da semana em que o período começa.
function segundaFeiraDaSemana(data: Date): string {
  const diaSemana = data.getUTCDay(); // 0 = domingo
  const deslocamentoDias = diaSemana === 0 ? 6 : diaSemana - 1;
  const segunda = new Date(data.getTime() - deslocamentoDias * 24 * MS_POR_HORA);
  return segunda.toISOString().slice(0, 10);
}

export interface ConformidadeSemanalCalculada {
  semanaInicio: string;
  taxaConformidade: number;
  totalFinalizados: number;
}

// PARTE 20: evolução de conformidade por semana — só semanas com pelo menos um checklist
// finalizado aparecem (mesmo espírito de calcularTendenciaMensal).
export function calcularEvolucaoConformidade(finalizados: ChecklistFinalizado[]): ConformidadeSemanalCalculada[] {
  const porSemana = new Map<string, { total: number; conformes: number }>();
  for (const f of finalizados) {
    const semana = segundaFeiraDaSemana(f.finalizadoEm);
    const atual = porSemana.get(semana) ?? { total: 0, conformes: 0 };
    atual.total += 1;
    if (f.todosConformes) atual.conformes += 1;
    porSemana.set(semana, atual);
  }
  return [...porSemana.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([semanaInicio, v]) => ({
      semanaInicio,
      taxaConformidade: v.total > 0 ? arredondar((v.conformes / v.total) * 100) : 0,
      totalFinalizados: v.total,
    }));
}

export interface NaoConformidadePorPlataformaCalculada {
  plataformaId: string;
  plataformaNome: string;
  naoConformidades: number;
}

// PARTE 21: quais plataformas mais aparecem em checklists não conformes.
export function calcularNaoConformidadePorPlataforma(
  finalizados: ChecklistFinalizado[]
): NaoConformidadePorPlataformaCalculada[] {
  const mapa = new Map<string, { nome: string; total: number }>();
  for (const f of finalizados) {
    if (f.todosConformes) continue;
    const atual = mapa.get(f.plataformaId) ?? { nome: f.plataformaNome, total: 0 };
    atual.total += 1;
    mapa.set(f.plataformaId, atual);
  }
  return [...mapa.entries()]
    .map(([plataformaId, v]) => ({ plataformaId, plataformaNome: v.nome, naoConformidades: v.total }))
    .sort((a, b) => b.naoConformidades - a.naoConformidades);
}

export interface ItemChecklistCriticoCalculado {
  itemDescricao: string;
  ocorrencias: number;
}

// PARTE 22: itens de checklist (pergunta) com mais respostas "não conforme" — usa o
// texto de snapshot (item_descricao em ChecklistResposta), estável mesmo se a pergunta
// for editada/removida depois. Top 10.
export function calcularItensChecklistCriticos(
  respostasNaoConformes: RespostaNaoConformeResumo[]
): ItemChecklistCriticoCalculado[] {
  const mapa = new Map<string, number>();
  for (const r of respostasNaoConformes) {
    mapa.set(r.itemDescricao, (mapa.get(r.itemDescricao) ?? 0) + 1);
  }
  return [...mapa.entries()]
    .map(([itemDescricao, ocorrencias]) => ({ itemDescricao, ocorrencias }))
    .sort((a, b) => b.ocorrencias - a.ocorrencias)
    .slice(0, 10);
}

export interface ChecklistPorCategoriaCalculada {
  categoria: CategoriaPlataforma;
  totalRealizados: number;
  totalConformes: number;
  totalNaoConformes: number;
}

// PARTE 23: checklists realizados/conformes por categoria de plataforma — proxy real mais
// próximo de "tipo de checklist" (NR-18/NR-35 não é um campo armazenado no schema atual).
export function calcularChecklistsPorCategoria(finalizados: ChecklistFinalizado[]): ChecklistPorCategoriaCalculada[] {
  const mapa = new Map<CategoriaPlataforma, { total: number; conformes: number }>();
  for (const f of finalizados) {
    const atual = mapa.get(f.categoria) ?? { total: 0, conformes: 0 };
    atual.total += 1;
    if (f.todosConformes) atual.conformes += 1;
    mapa.set(f.categoria, atual);
  }
  return [...mapa.entries()]
    .map(([categoria, v]) => ({
      categoria,
      totalRealizados: v.total,
      totalConformes: v.conformes,
      totalNaoConformes: v.total - v.conformes,
    }))
    .sort((a, b) => b.totalRealizados - a.totalRealizados);
}

export interface ChecklistPorSetorCalculada {
  setorId: string;
  setorNome: string;
  totalRealizados: number;
  totalConformes: number;
  totalNaoConformes: number;
}

// PARTE 24: checklists realizados/conformes/não conformes por setor.
export function calcularChecklistsPorSetor(finalizados: ChecklistFinalizado[]): ChecklistPorSetorCalculada[] {
  const mapa = new Map<string, { nome: string; total: number; conformes: number }>();
  for (const f of finalizados) {
    const atual = mapa.get(f.setorId) ?? { nome: f.setorNome, total: 0, conformes: 0 };
    atual.total += 1;
    if (f.todosConformes) atual.conformes += 1;
    mapa.set(f.setorId, atual);
  }
  return [...mapa.entries()]
    .map(([setorId, v]) => ({
      setorId,
      setorNome: v.nome,
      totalRealizados: v.total,
      totalConformes: v.conformes,
      totalNaoConformes: v.total - v.conformes,
    }))
    .sort((a, b) => b.totalRealizados - a.totalRealizados);
}

export interface RelacaoReservaChecklistCalculada {
  reservasQueExigiamChecklist: number;
  reservasComChecklistRealizado: number;
  reservasIniciadasAposChecklist: number;
}

// PARTE 26: relação reserva↔checklist. "Iniciadas após checklist" conta reservas que
// chegaram a em_uso/concluida exigindo checklist — só é possível porque essa transição já
// é bloqueada por checklist não finalizado/não conforme (reservaTransicao.service.ts), não
// é uma suposição. "Reservas impedidas por checklist não conforme" NÃO é calculável com o
// schema atual (o 409 de POST /reservas/:id/aprovar não é gravado em LogAuditoria) — ver
// relatório final.
export function calcularRelacaoReservaChecklist(
  reservas: ReservaChecklistResumo[]
): RelacaoReservaChecklistCalculada {
  const exigiam = reservas.filter((r) => r.requerChecklist);
  const realizado = exigiam.filter((r) => r.checklistFinalizado);
  const iniciadas = exigiam.filter((r) => r.status === "em_uso" || r.status === "concluida");
  return {
    reservasQueExigiamChecklist: exigiam.length,
    reservasComChecklistRealizado: realizado.length,
    reservasIniciadasAposChecklist: iniciadas.length,
  };
}

// ---------------------------------------------------------------------------
// Relatório de Não Conformidades — GET /relatorios/nao-conformidades
//
// Substitui a aba "Segurança & Checklists": o checklist deixou de ser etapa da reserva
// (migration 0018) e as tabelas de checklist (ChecklistTemplate/ChecklistPreenchido/
// ChecklistResposta) continuam intactas só como histórico congelado — não recebem
// consulta nova aqui. A fonte real de não conformidade, desde 0018, é
// Comentario.tipo='nao_conformidade' + o status de tratamento em NaoConformidade
// (migration 0021, 1:1 com o comentário).
// ---------------------------------------------------------------------------

export interface NaoConformidadeResumo {
  status: StatusNaoConformidade;
  setorId: string;
  setorNome: string;
  plataformaId: string;
  plataformaNome: string;
  criadoEm: Date;
  resolvidoEm: Date | null;
}

export interface KpisNaoConformidadeCalculados {
  total: number;
  abertas: number;
  emAnalise: number;
  resolvidas: number;
  /** null quando total=0 — matematicamente não aplicável (a UI mostra "—", nunca "0%"). */
  taxaResolucao: number | null;
}

export function calcularKpisNaoConformidades(itens: NaoConformidadeResumo[]): KpisNaoConformidadeCalculados {
  const total = itens.length;
  const abertas = itens.filter((i) => i.status === "aberta").length;
  const emAnalise = itens.filter((i) => i.status === "em_analise").length;
  const resolvidas = itens.filter((i) => i.status === "resolvida").length;
  return {
    total,
    abertas,
    emAnalise,
    resolvidas,
    taxaResolucao: total > 0 ? arredondar((resolvidas / total) * 100) : null,
  };
}

export interface NaoConformidadeSemanalCalculada {
  semanaInicio: string;
  total: number;
}

// Evolução por semana — mesmo critério de calcularEvolucaoConformidade (só semanas com
// pelo menos um registro aparecem), agrupando por criadoEm em vez de finalizadoEm (não
// conformidade não tem um "fim" de execução, só um instante de registro).
export function calcularEvolucaoNaoConformidades(itens: NaoConformidadeResumo[]): NaoConformidadeSemanalCalculada[] {
  const porSemana = new Map<string, number>();
  for (const item of itens) {
    const semana = segundaFeiraDaSemana(item.criadoEm);
    porSemana.set(semana, (porSemana.get(semana) ?? 0) + 1);
  }
  return [...porSemana.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([semanaInicio, total]) => ({ semanaInicio, total }));
}

export interface NaoConformidadePorSetorCalculada {
  setorId: string;
  setorNome: string;
  total: number;
}

export function calcularNaoConformidadesPorSetor(itens: NaoConformidadeResumo[]): NaoConformidadePorSetorCalculada[] {
  const mapa = new Map<string, { nome: string; total: number }>();
  for (const item of itens) {
    const atual = mapa.get(item.setorId) ?? { nome: item.setorNome, total: 0 };
    atual.total += 1;
    mapa.set(item.setorId, atual);
  }
  return [...mapa.entries()]
    .map(([setorId, v]) => ({ setorId, setorNome: v.nome, total: v.total }))
    .sort((a, b) => b.total - a.total);
}

export interface NaoConformidadesPorPlataformaCalculada {
  plataformaId: string;
  plataformaNome: string;
  total: number;
}

export function calcularNaoConformidadesPorPlataforma(
  itens: NaoConformidadeResumo[]
): NaoConformidadesPorPlataformaCalculada[] {
  const mapa = new Map<string, { nome: string; total: number }>();
  for (const item of itens) {
    const atual = mapa.get(item.plataformaId) ?? { nome: item.plataformaNome, total: 0 };
    atual.total += 1;
    mapa.set(item.plataformaId, atual);
  }
  return [...mapa.entries()]
    .map(([plataformaId, v]) => ({ plataformaId, plataformaNome: v.nome, total: v.total }))
    .sort((a, b) => b.total - a.total);
}

export interface NaoConformidadePorStatusCalculada {
  status: StatusNaoConformidade;
  total: number;
}

// Sempre os 3 status, mesmo com total 0 — um gráfico "por status" que sumisse com uma
// fatia vazia enganaria mais do que uma fatia zerada.
export function calcularNaoConformidadesPorStatus(itens: NaoConformidadeResumo[]): NaoConformidadePorStatusCalculada[] {
  const contagem: Record<StatusNaoConformidade, number> = { aberta: 0, em_analise: 0, resolvida: 0 };
  for (const item of itens) contagem[item.status] += 1;
  return (["aberta", "em_analise", "resolvida"] as const).map((status) => ({ status, total: contagem[status] }));
}
