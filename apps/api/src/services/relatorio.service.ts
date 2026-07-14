import type { CategoriaPlataforma, StatusReserva } from "@plataformares/shared";
import { combinarDataHora } from "./conflito.service.js";

// SDD §6.7 (RF-REL-01..05) — este módulo separa cálculo puro (testável com fixture,
// sem I/O) da consulta SQL que alimenta cada função: routes/relatorios.ts busca as
// linhas cruas do banco e repassa para as funções abaixo, que fazem a agregação.

export interface PeriodoRelatorio {
  dateFrom: string; // YYYY-MM-DD, inclusivo
  dateTo: string; // YYYY-MM-DD, inclusivo
}

function inicioPeriodo(periodo: PeriodoRelatorio): Date {
  return combinarDataHora(periodo.dateFrom, "00:00");
}

// Limite EXCLUSIVO do período (00:00 do dia seguinte a dateTo) — dateTo é inclusivo.
function fimPeriodoExclusivo(periodo: PeriodoRelatorio): Date {
  const fim = combinarDataHora(periodo.dateTo, "00:00");
  fim.setUTCDate(fim.getUTCDate() + 1);
  return fim;
}

function horasNoPeriodo(periodo: PeriodoRelatorio): number {
  const ms = fimPeriodoExclusivo(periodo).getTime() - inicioPeriodo(periodo).getTime();
  return ms / (60 * 60 * 1000);
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
        const inicio = combinarDataHora(r.data, r.horaInicio);
        const fim = combinarDataHora(r.data, r.horaFim);
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
