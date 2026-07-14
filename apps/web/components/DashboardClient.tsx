"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowRight,
  ArrowUpRight,
  AlertTriangle,
} from "lucide-react";
import styles from "../app/(app)/dashboard/page.module.css";
import { apiFetch } from "../lib/api";

const COR_GRADE = "#DEDAD1";
const COR_EIXO = "#6E6961";
const COR_TOOLTIP_BG = "#221F1B";
const COR_RESERVAS = "oklch(0.68 0.16 55)";
const COR_CONCLUIDAS = "oklch(0.5 0.09 240)";

const CATEGORIA_LABEL: Record<string, string> = {
  elevatoria: "Elevatória",
  andaime: "Andaime",
  sala: "Sala técnica",
  patio: "Pátio",
  veiculo: "Veículo",
  outro: "Outro",
};

const CATEGORIA_NR: Record<string, string> = {
  elevatoria: "NR-35",
  andaime: "NR-18",
};

function requerChecklist(categoria: string): boolean {
  return categoria === "elevatoria" || categoria === "andaime";
}

interface Kpis {
  totalPlataformas: number;
  disponiveis: number;
  emUso: number;
  manutencao: number;
  reservasHoje: number;
  reservasProximos7Dias: number;
  pendenciasAprovacao: number;
  checklistsPendentes: number;
}

interface ReservaAgenda {
  id: string;
  setorNome: string;
  solicitanteId: string;
  solicitanteNome: string;
  plataformaId: string;
  plataformaNome: string;
  plataformaCategoria: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  motivo: string;
  prioridade: string;
  status: string;
}

interface Agenda {
  hoje: ReservaAgenda[];
  proximas: ReservaAgenda[];
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  categoria: string;
  status: string;
}

interface ReservaFila extends ReservaAgenda {
  criadoEm: string;
  aguardaSegundaAprovacao: boolean;
  slaHoras: number;
  slaEstourado: boolean;
}

interface ChecklistItemTemplate {
  id: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  ativo: boolean;
}

interface ItemDistribuicao {
  chave: string;
  quantidade: number;
}
interface UtilizacaoPlataforma {
  plataformaId: string;
  codigo: string;
  nome: string;
  taxaUtilizacao: number;
}
interface UtilizacaoResposta {
  plataformas: UtilizacaoPlataforma[];
}
interface SlaResposta {
  porStatus: ItemDistribuicao[];
  tendenciaMensal: { mes: string; quantidade: number }[];
}
interface RankingSetorItem {
  setorId: string;
  setorNome: string;
  corHex: string;
  totalReservas: number;
  taxaRejeicao: number;
}

export interface DashboardClientProps {
  usuarioId: string;
  usuarioNome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorNome: string | null;
}

function saudacao(): string {
  const hora = new Date().getHours();
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

function numeroSemana(data: Date): number {
  const d = new Date(Date.UTC(data.getFullYear(), data.getMonth(), data.getDate()));
  const diaSemana = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - diaSemana);
  const inicioAno = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - inicioAno.getTime()) / 86400000 + 1) / 7);
}

function eyebrowHero(): string {
  const agora = new Date();
  const semana = numeroSemana(agora);
  const texto = agora.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  return `${texto} · SEMANA ${semana}`.toUpperCase();
}

function formatarDataCurta(data: string): string {
  const [, mes, dia] = data.split("-");
  return `${dia}/${mes}`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function primeiroDiaMesesAtras(quantidade: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - quantidade);
  return d.toISOString().slice(0, 10);
}
function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

function nomeCurto(nomeCompleto: string): string {
  const partes = nomeCompleto.trim().split(/\s+/);
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1][0]}.`;
}

function codigoSolicitacao(id: string): string {
  return `R-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function formatarAguardando(desde: string): string {
  const ms = Date.now() - new Date(desde).getTime();
  if (ms < 0) return "agora";
  const horas = ms / 3_600_000;
  if (horas < 1) return `${Math.max(1, Math.round(ms / 60_000))}min`;
  if (horas < 24) return `${Math.floor(horas)}h`;
  return `${Math.floor(horas / 24)}d`;
}

function formatarContagemRegressiva(data: string, hora: string): string {
  const alvo = new Date(`${data}T${hora}:00`);
  const diffMs = alvo.getTime() - Date.now();
  if (diffMs <= 0) return "atrasado";
  const horas = Math.floor(diffMs / 3_600_000);
  const minutos = Math.floor((diffMs % 3_600_000) / 60_000);
  return horas > 0 ? `em ${horas}h${String(minutos).padStart(2, "0")}` : `em ${minutos}min`;
}

// Régua fixa 07:00–17:00 (11 marcações), conforme especificacao.md §4.6.
const HORA_INICIO_RUA = 7;
const HORA_FIM_RUA = 17;
const HORAS_RUA = Array.from({ length: 11 }, (_, i) => HORA_INICIO_RUA + i);

function posicaoNaRegua(horaStr: string): number {
  const [h, m] = horaStr.split(":").map(Number);
  const fracao = (h + m / 60 - HORA_INICIO_RUA) / 11;
  return Math.min(1, Math.max(0, fracao));
}

function dentroDaRegua(horaInicio: string, horaFim: string): boolean {
  const [hi] = horaInicio.split(":").map(Number);
  const [hf] = horaFim.split(":").map(Number);
  return hf > HORA_INICIO_RUA && hi < HORA_FIM_RUA;
}

const STATUS_PILL: Record<string, { label: string; classe: string }> = {
  concluida: { label: "Concluída", classe: "pillConcluida" },
  em_uso: { label: "Em Campo", classe: "pillEmUso" },
  agendada: { label: "Agendada", classe: "pillAgendada" },
  pendente: { label: "Aguardando Aprovação", classe: "pillPendente" },
};

function StatusPill({ item, checklistPendenteIds }: { item: ReservaAgenda; checklistPendenteIds: Set<string> }) {
  if (item.status === "agendada" && checklistPendenteIds.has(item.id)) {
    return <span className={`${styles.pill} ${styles.pillChecklist}`}>Checklist Pendente</span>;
  }
  const info = STATUS_PILL[item.status] ?? { label: item.status, classe: "pillAgendada" };
  return <span className={`${styles.pill} ${styles[info.classe]}`}>{info.label}</span>;
}

export function DashboardClient({ usuarioId, usuarioNome, perfil, setorNome }: DashboardClientProps) {
  const ehAprovador = perfil === "admin" || perfil === "gestor_setor";
  const periodo = useMemo(() => ({ dateFrom: primeiroDiaMesesAtras(5), dateTo: hoje() }), []);

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [plataformas, setPlataformas] = useState<Plataforma[]>([]);
  const [checklistsPendentes, setChecklistsPendentes] = useState<ReservaAgenda[]>([]);
  const [checklistItens, setChecklistItens] = useState<ChecklistItemTemplate[]>([]);
  const [filaAprovacoes, setFilaAprovacoes] = useState<ReservaFila[]>([]);
  const [aprovandoId, setAprovandoId] = useState<string | null>(null);
  const [utilizacao, setUtilizacao] = useState<UtilizacaoResposta | null>(null);
  const [sla, setSla] = useState<SlaResposta | null>(null);
  const [ranking, setRanking] = useState<RankingSetorItem[] | null>(null);
  const [ultimaSincronizacao, setUltimaSincronizacao] = useState<string>("");

  useEffect(() => {
    let cancelado = false;

    async function carregar(primeiraVez: boolean) {
      if (primeiraVez) setCarregando(true);
      try {
        const query = `dateFrom=${periodo.dateFrom}&dateTo=${periodo.dateTo}`;
        const promessas: Promise<unknown>[] = [
          apiFetch<Kpis>("/api/v1/dashboard/kpis"),
          apiFetch<Agenda>("/api/v1/dashboard/agenda"),
          apiFetch<Plataforma[]>("/api/v1/plataformas"),
          apiFetch<ReservaAgenda[]>("/api/v1/dashboard/checklists-pendentes"),
        ];
        if (ehAprovador) {
          promessas.push(apiFetch<ReservaFila[]>("/api/v1/reservas/fila-aprovacoes"));
          promessas.push(apiFetch<UtilizacaoResposta>(`/api/v1/relatorios/utilizacao?${query}`));
          promessas.push(apiFetch<SlaResposta>(`/api/v1/relatorios/sla-aprovacao?${query}`));
        }
        if (perfil === "admin") {
          promessas.push(apiFetch<{ setores: RankingSetorItem[] }>(`/api/v1/relatorios/ranking-setores?${query}`));
        }
        const resultados = await Promise.all(promessas);
        if (cancelado) return;

        setKpis(resultados[0] as Kpis);
        setAgenda(resultados[1] as Agenda);
        setPlataformas(resultados[2] as Plataforma[]);
        setChecklistsPendentes(resultados[3] as ReservaAgenda[]);
        let proximoIndice = 4;
        if (ehAprovador) {
          setFilaAprovacoes(resultados[proximoIndice] as ReservaFila[]);
          setUtilizacao(resultados[proximoIndice + 1] as UtilizacaoResposta);
          setSla(resultados[proximoIndice + 2] as SlaResposta);
          proximoIndice += 3;
        }
        if (perfil === "admin") {
          setRanking((resultados[proximoIndice] as { setores: RankingSetorItem[] }).setores);
        }
        setUltimaSincronizacao(nowHHMM());
        setErro(null);
      } catch (err) {
        if (!cancelado) setErro(err instanceof Error ? err.message : "Erro ao carregar o dashboard.");
      } finally {
        if (!cancelado && primeiraVez) setCarregando(false);
      }
    }

    carregar(true);
    const intervalo = setInterval(() => carregar(false), 60_000);
    return () => {
      cancelado = true;
      clearInterval(intervalo);
    };
  }, [ehAprovador, perfil, periodo]);

  useEffect(() => {
    if (checklistsPendentes.length === 0) {
      setChecklistItens([]);
      return;
    }
    let cancelado = false;
    apiFetch<ChecklistItemTemplate[]>(`/api/v1/checklist-templates?categoria=${checklistsPendentes[0].plataformaCategoria}`)
      .then((itens) => {
        if (!cancelado) setChecklistItens(itens.filter((i) => i.ativo).sort((a, b) => a.ordem - b.ordem));
      })
      .catch(() => {
        if (!cancelado) setChecklistItens([]);
      });
    return () => {
      cancelado = true;
    };
  }, [checklistsPendentes]);

  const checklistPendenteIds = useMemo(() => new Set(checklistsPendentes.map((r) => r.id)), [checklistsPendentes]);

  async function aprovarReserva(id: string) {
    setAprovandoId(id);
    try {
      await apiFetch(`/api/v1/reservas/${id}/aprovar`, { method: "POST" });
      setFilaAprovacoes((atual) => atual.filter((r) => r.id !== id));
      setKpis((atual) => (atual ? { ...atual, pendenciasAprovacao: Math.max(0, atual.pendenciasAprovacao - 1) } : atual));
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao aprovar a reserva.");
    } finally {
      setAprovandoId(null);
    }
  }

  const plataformasPorId = useMemo(() => new Map(plataformas.map((p) => [p.id, p])), [plataformas]);

  const emUsoAgora = useMemo(() => agenda?.hoje.find((r) => r.status === "em_uso") ?? null, [agenda]);
  const proximoChecklist = checklistsPendentes[0] ?? null;

  const manutencaoPlataformas = useMemo(() => plataformas.filter((p) => p.status === "manutencao"), [plataformas]);

  const atrasadasAprovacao = useMemo(() => filaAprovacoes.filter((r) => r.slaEstourado).length, [filaAprovacoes]);
  const slaHorasAprovacao = filaAprovacoes[0]?.slaHoras;

  const contextoHero = useMemo(() => {
    if (!kpis) return "";
    if (ehAprovador) {
      const pontos = kpis.pendenciasAprovacao + kpis.checklistsPendentes;
      if (pontos === 0) return "Nenhum ponto pendente de decisão hoje.";
      return pontos === 1 ? "1 ponto exige sua decisão hoje." : `${pontos} pontos exigem sua decisão hoje.`;
    }
    return kpis.reservasHoje > 0
      ? `Você tem ${kpis.reservasHoje === 1 ? "1 reserva" : `${kpis.reservasHoje} reservas`} hoje.`
      : "Nenhuma reserva agendada para hoje.";
  }, [kpis, ehAprovador]);

  const minhasProximas = useMemo(() => {
    if (!agenda) return [];
    return [...agenda.hoje, ...agenda.proximas].filter((r) => r.solicitanteId === usuarioId);
  }, [agenda, usuarioId]);

  const utilizacaoOrdenada = useMemo(() => {
    if (!utilizacao) return [];
    return [...utilizacao.plataformas].sort((a, b) => b.taxaUtilizacao - a.taxaUtilizacao);
  }, [utilizacao]);
  const mediaUtilizacao = useMemo(() => {
    if (utilizacaoOrdenada.length === 0) return 0;
    return Math.round((utilizacaoOrdenada.reduce((s, p) => s + p.taxaUtilizacao, 0) / utilizacaoOrdenada.length) * 10) / 10;
  }, [utilizacaoOrdenada]);

  const concluidaRatio = useMemo(() => {
    if (!sla) return 0;
    const total = sla.porStatus.reduce((s, i) => s + i.quantidade, 0);
    const concluidas = sla.porStatus.find((i) => i.chave === "concluida")?.quantidade ?? 0;
    return total > 0 ? concluidas / total : 0;
  }, [sla]);
  const trendData = useMemo(
    () => sla?.tendenciaMensal.map((t) => ({ mes: t.mes, reservas: t.quantidade, concluidas: Math.round(t.quantidade * concluidaRatio) })) ?? [],
    [sla, concluidaRatio]
  );

  const maiorRankingSetor = useMemo(() => {
    if (!ranking || ranking.length === 0) return 0;
    return Math.max(...ranking.map((s) => s.totalReservas));
  }, [ranking]);

  const agoraFracaoRegua = useMemo(() => {
    const [h, m] = nowHHMM().split(":").map(Number);
    if (h < HORA_INICIO_RUA || h >= HORA_FIM_RUA) return null;
    return (h + m / 60 - HORA_INICIO_RUA) / 11;
  }, []);

  if (carregando) {
    return (
      <section>
        <div className={styles.loading}>Carregando dashboard...</div>
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <div className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>{eyebrowHero()}</div>
          <h1 className={styles.h1}>
            {saudacao()}, {usuarioNome.split(" ")[0]}.
            <em>{contextoHero}</em>
          </h1>
        </div>
        <div className={styles.heroActions}>
          <Link href="/relatorios" className={styles.btnOutline}>
            Exportar briefing
          </Link>
          {ehAprovador ? (
            <Link href="/reservas/aprovacoes" className={styles.btnSolid}>
              Abrir fila de aprovações
              <ArrowRight size={15} strokeWidth={1.75} />
            </Link>
          ) : (
            <Link href="/reservas" className={styles.btnSolid}>
              Minhas reservas
              <ArrowRight size={15} strokeWidth={1.75} />
            </Link>
          )}
        </div>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      {kpis && (
        <div className={styles.kpiStrip}>
          <div className={`${styles.kpiCell} ${styles.kpiInk}`}>
            <span className={styles.kpiLabel}>Frota Total</span>
            <span className={styles.kpiValue}>{kpis.totalPlataformas}</span>
            <span className={styles.kpiSub}>unidades ativas</span>
            <span className={styles.kpiTrend}>{kpis.manutencao > 0 ? `${kpis.manutencao} em manutenção` : "todas operacionais"}</span>
          </div>
          <div className={`${styles.kpiCell} ${styles.kpiGreen}`}>
            <span className={styles.kpiLabel}>Disponíveis Agora</span>
            <span className={styles.kpiValue}>{kpis.disponiveis}</span>
            <span className={styles.kpiSub}>de {kpis.totalPlataformas}</span>
            <span className={styles.kpiTrend}>
              {kpis.totalPlataformas > 0 ? `${Math.round((kpis.disponiveis / kpis.totalPlataformas) * 100)}%` : "—"}
            </span>
          </div>
          <div className={`${styles.kpiCell} ${styles.kpiBlue}`}>
            <span className={styles.kpiLabel}>Em Operação</span>
            <span className={styles.kpiValue}>{kpis.emUso}</span>
            <span className={styles.kpiSub}>
              {emUsoAgora ? `${plataformasPorId.get(emUsoAgora.plataformaId)?.codigo ?? emUsoAgora.plataformaNome} · ${emUsoAgora.setorNome}` : "—"}
            </span>
            <span className={styles.kpiTrend}>{emUsoAgora ? `até ${emUsoAgora.horaFim}` : ""}</span>
          </div>
          <div className={`${styles.kpiCell} ${styles.kpiOrange}`}>
            <span className={styles.kpiLabel}>Em Manutenção</span>
            <span className={styles.kpiValue}>{kpis.manutencao}</span>
            <span className={styles.kpiSub}>plataformas indisponíveis</span>
            <span className={styles.kpiTrend}>{manutencaoPlataformas.map((p) => p.codigo).join(" · ") || "—"}</span>
          </div>
          {ehAprovador ? (
            <div className={`${styles.kpiCell} ${styles.kpiRed}`}>
              <span className={styles.kpiLabel}>Aprovações Pendentes</span>
              <span className={styles.kpiValue}>{kpis.pendenciasAprovacao}</span>
              <span className={styles.kpiSub}>{slaHorasAprovacao ? `SLA médio ${slaHorasAprovacao}h` : "sem pendências"}</span>
              <span className={`${styles.kpiTrend} ${atrasadasAprovacao > 0 ? styles.kpiTrendHazard : ""}`}>
                {atrasadasAprovacao > 0 ? `${atrasadasAprovacao} atrasada${atrasadasAprovacao > 1 ? "s" : ""}` : "em dia"}
              </span>
            </div>
          ) : (
            <div className={`${styles.kpiCell} ${styles.kpiRed}`}>
              <span className={styles.kpiLabel}>Reservas Hoje</span>
              <span className={styles.kpiValue}>{kpis.reservasHoje}</span>
              <span className={styles.kpiSub}>agendadas para hoje</span>
              <span className={styles.kpiTrend}>{kpis.reservasProximos7Dias} nos próx. 7 dias</span>
            </div>
          )}
          <div className={`${styles.kpiCell} ${styles.kpiOrange}`}>
            <span className={styles.kpiLabel}>Checklists NR</span>
            <span className={styles.kpiValue}>{kpis.checklistsPendentes}</span>
            <span className={styles.kpiSub}>
              {proximoChecklist ? `${proximoChecklist.horaInicio} · ${plataformasPorId.get(proximoChecklist.plataformaId)?.codigo ?? proximoChecklist.plataformaNome}` : "nenhum pendente"}
            </span>
            <span className={styles.kpiTrend}>
              {proximoChecklist ? formatarContagemRegressiva(proximoChecklist.data, proximoChecklist.horaInicio) : ""}
            </span>
          </div>
        </div>
      )}

      <div className={styles.grid12}>
        <div className={`${styles.panel} ${styles.colSpan8}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Operações · Hoje</div>
              <h2 className={styles.panelTitle}>Agenda em curso</h2>
            </div>
            <div className={styles.legend}>
              <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendEmUso}`} />Em uso</span>
              <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendConcluida}`} />Concluída</span>
              <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendChecklist}`} />Checklist</span>
            </div>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.timeline}>
              <div className={styles.timelineRuler}>
                {HORAS_RUA.map((h) => (
                  <span key={h} className={styles.timelineTick}>
                    {String(h).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              <div className={styles.timelineLane}>
                {agenda?.hoje.filter((r) => dentroDaRegua(r.horaInicio, r.horaFim)).map((r) => {
                  const left = posicaoNaRegua(r.horaInicio);
                  const right = posicaoNaRegua(r.horaFim);
                  const largura = Math.max(0.02, right - left);
                  const classeCor =
                    r.status === "em_uso"
                      ? styles.barEmUso
                      : r.status === "concluida"
                        ? styles.barConcluida
                        : checklistPendenteIds.has(r.id)
                          ? styles.barChecklist
                          : styles.barAgendada;
                  return (
                    <div
                      key={r.id}
                      className={`${styles.timelineBar} ${classeCor}`}
                      style={{ left: `${left * 100}%`, width: `${largura * 100}%` }}
                      title={`${r.plataformaNome} — ${r.horaInicio}–${r.horaFim}`}
                    >
                      <span className={styles.timelineBarTime}>
                        {r.horaInicio}–{r.horaFim}
                      </span>
                      <span className={styles.timelineBarLabel}>{r.motivo || r.plataformaNome}</span>
                    </div>
                  );
                })}
                {agoraFracaoRegua !== null && (
                  <div className={styles.nowMarker} style={{ left: `${agoraFracaoRegua * 100}%` }}>
                    <span className={styles.nowLabel}>AGORA</span>
                  </div>
                )}
              </div>
            </div>

            {(!agenda || agenda.hoje.length === 0) && <div className={styles.empty}>Nenhuma reserva para hoje.</div>}

            <div className={styles.agendaList}>
              {agenda?.hoje.map((r) => (
                <div key={r.id} className={styles.agendaRow}>
                  <span className={styles.agendaTime}>
                    {r.horaInicio}–{r.horaFim}
                  </span>
                  <div className={styles.agendaInfo}>
                    <span className={styles.agendaTitle}>{r.motivo || r.plataformaNome}</span>
                    <span className={styles.agendaMeta}>
                      {plataformasPorId.get(r.plataformaId)?.codigo ?? r.plataformaNome} · {r.setorNome} · {r.solicitanteNome}
                    </span>
                  </div>
                  <StatusPill item={r} checklistPendenteIds={checklistPendenteIds} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={`${styles.panel} ${styles.colSpan4}`}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Frota</div>
              <h2 className={styles.panelTitle}>Status em tempo real</h2>
            </div>
          </div>
          <div className={styles.panelBody}>
            {plataformas.length === 0 ? (
              <div className={styles.empty}>Nenhuma plataforma cadastrada.</div>
            ) : (
              <div className={styles.fleetList}>
                {plataformas.map((p) => {
                  const emUso = agenda?.hoje.find((r) => r.plataformaId === p.id && r.status === "em_uso");
                  const proxima = agenda?.hoje
                    .filter((r) => r.plataformaId === p.id && (r.status === "agendada" || r.status === "pendente") && r.horaInicio > nowHHMM())
                    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))[0];
                  let statusLabel = "Disponível";
                  let detalhe = "Disponível agora";
                  let dotClasse = styles.fleetDotDisponivel;
                  let corClasse = styles.fleetCorDisponivel;
                  if (p.status === "reservada") {
                    statusLabel = "Em Uso";
                    dotClasse = styles.fleetDotEmUso;
                    corClasse = styles.fleetCorEmUso;
                    detalhe = emUso ? `${emUso.setorNome} · retorno ${emUso.horaFim}` : "Em uso";
                  } else if (p.status === "manutencao") {
                    statusLabel = "Em Manutenção";
                    dotClasse = styles.fleetDotManutencao;
                    corClasse = styles.fleetCorManutencao;
                    detalhe = "Indisponível por manutenção";
                  } else if (p.status === "inativa") {
                    statusLabel = "Inativa";
                    dotClasse = styles.fleetDotInativa;
                    corClasse = styles.fleetCorInativa;
                    detalhe = "Fora de operação";
                  } else if (proxima) {
                    detalhe = `Livre até ${proxima.horaInicio}`;
                  }
                  return (
                    <div key={p.id} className={styles.fleetRow}>
                      <span className={`${styles.fleetDot} ${dotClasse}`} />
                      <div className={styles.fleetInfo}>
                        <span className={styles.fleetCode}>{p.codigo}</span>
                        <span className={styles.fleetName}>{p.nome}</span>
                        <span className={styles.fleetMeta}>
                          {CATEGORIA_LABEL[p.categoria] ?? p.categoria} · {p.localizacao ?? "—"}
                        </span>
                      </div>
                      <div className={styles.fleetStatus}>
                        <span className={`${styles.fleetStatusLabel} ${corClasse}`}>{statusLabel}</span>
                        <span className={styles.fleetDetail}>{detalhe}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className={styles.panelFooter}>
            <span>Última sincronização: {ultimaSincronizacao}</span>
            <Link href="/plataformas" className={styles.footerLink}>
              Ver frota completa <ArrowUpRight size={13} strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>

      <div className={styles.grid12}>
        {ehAprovador ? (
          <div className={`${styles.panel} ${styles.colSpan8}`}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelEyebrow}>Ação Necessária</div>
                <h2 className={styles.panelTitle}>Fila de aprovações</h2>
              </div>
              <span className={styles.panelHeaderMeta}>
                {filaAprovacoes.length} pendentes{slaHorasAprovacao ? ` · SLA médio ${slaHorasAprovacao}h` : ""}
                {atrasadasAprovacao > 0 ? ` · ${atrasadasAprovacao} atrasada${atrasadasAprovacao > 1 ? "s" : ""}` : ""}
              </span>
            </div>
            <div className={styles.tableWrap}>
              {filaAprovacoes.length === 0 ? (
                <div className={styles.empty}>Nenhuma reserva aguardando aprovação.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Solicitação</th>
                      <th>Setor</th>
                      <th>Janela</th>
                      <th>Plataforma</th>
                      <th>Risco</th>
                      <th>Aguardando</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filaAprovacoes.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className={styles.tableCodigo}>{codigoSolicitacao(r.id)}</span>
                          <span className={styles.tableSub}>{nomeCurto(r.solicitanteNome)}</span>
                        </td>
                        <td>{r.setorNome}</td>
                        <td className={styles.tableMono}>
                          {formatarDataCurta(r.data)} · {r.horaInicio}–{r.horaFim}
                        </td>
                        <td>{plataformasPorId.get(r.plataformaId)?.codigo ?? r.plataformaNome}</td>
                        <td>
                          {requerChecklist(r.plataformaCategoria) ? (
                            <span className={styles.riskBadge}>{CATEGORIA_NR[r.plataformaCategoria] ?? "NR"}</span>
                          ) : (
                            <span className={styles.tableSub}>—</span>
                          )}
                        </td>
                        <td className={`${styles.tableMono} ${r.slaEstourado ? styles.tableHazard : ""}`}>
                          {formatarAguardando(r.criadoEm)}
                        </td>
                        <td>
                          <div className={styles.tableActions}>
                            <Link href="/reservas/aprovacoes" className={styles.btnGhostSm}>
                              Rever
                            </Link>
                            <button
                              type="button"
                              className={styles.btnSolidSm}
                              disabled={aprovandoId === r.id}
                              onClick={() => aprovarReserva(r.id)}
                            >
                              Aprovar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <div className={`${styles.panel} ${styles.colSpan8}`}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelEyebrow}>Agenda</div>
                <h2 className={styles.panelTitle}>Minhas próximas reservas</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {minhasProximas.length === 0 ? (
                <div className={styles.empty}>Você não tem reservas nos próximos dias.</div>
              ) : (
                <div className={styles.agendaList}>
                  {minhasProximas.map((r) => (
                    <div key={r.id} className={styles.agendaRow}>
                      <span className={styles.agendaTime}>
                        {formatarDataCurta(r.data)} {r.horaInicio}
                      </span>
                      <div className={styles.agendaInfo}>
                        <span className={styles.agendaTitle}>{r.plataformaNome}</span>
                        <span className={styles.agendaMeta}>{r.motivo}</span>
                      </div>
                      <StatusPill item={r} checklistPendenteIds={checklistPendenteIds} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className={`${styles.panel} ${styles.colSpan4} ${styles.alertPanel}`}>
          {proximoChecklist ? (
            <>
              <div className={styles.alertHeader}>
                <div className={styles.alertIcon}>
                  <AlertTriangle size={20} strokeWidth={1.75} />
                </div>
                <div>
                  <div className={styles.panelEyebrow}>Conformidade · NR-18 / NR-35</div>
                  <h2 className={styles.alertTitle}>
                    Checklist de segurança pendente {formatarContagemRegressiva(proximoChecklist.data, proximoChecklist.horaInicio)}.
                  </h2>
                </div>
              </div>
              <div className={styles.alertBody}>
                <div className={styles.alertMetaRow}>
                  <span className={styles.tableMono}>
                    {proximoChecklist.horaInicio} · {plataformasPorId.get(proximoChecklist.plataformaId)?.codigo ?? proximoChecklist.plataformaNome}
                  </span>
                  <span className={styles.priorityTag}>{proximoChecklist.prioridade.toUpperCase()}</span>
                </div>
                <p className={styles.alertSub}>
                  {proximoChecklist.setorNome} · {proximoChecklist.solicitanteNome} · {proximoChecklist.plataformaNome}
                </p>
                {checklistItens.length > 0 && (
                  <ul className={styles.checklistItemsList}>
                    {checklistItens.map((item) => (
                      <li key={item.id}>{item.descricao}</li>
                    ))}
                  </ul>
                )}
                <div className={styles.alertActions}>
                  <Link href={`/reservas/${proximoChecklist.id}`} className={styles.btnSolid}>
                    Iniciar checklist
                  </Link>
                  <button type="button" className={styles.btnOutlineSm} title="Disponível em uma próxima sprint" disabled>
                    Delegar
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className={styles.panelBody}>
              <div className={styles.panelEyebrow}>Conformidade · NR-18 / NR-35</div>
              <h2 className={styles.panelTitle}>Checklists em dia</h2>
              <p className={styles.alertSub}>Nenhum checklist de segurança pendente no momento.</p>
            </div>
          )}
        </div>
      </div>

      {ehAprovador && (
        <div className={styles.grid12}>
          <div className={`${styles.panel} ${styles.colSpan7}`}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelEyebrow}>Últimos 6 meses</div>
                <h2 className={styles.panelTitle}>Reservas x Concluídas</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {trendData.length === 0 ? (
                <div className={styles.empty}>Sem dados de tendência no período.</div>
              ) : (
                <ResponsiveContainer width="100%" height={288}>
                  <AreaChart data={trendData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                    <defs>
                      <linearGradient id="gReservas" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COR_RESERVAS} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={COR_RESERVAS} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gConcluidas" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COR_CONCLUIDAS} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={COR_CONCLUIDAS} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 4" stroke={COR_GRADE} vertical={false} />
                    <XAxis dataKey="mes" stroke={COR_EIXO} tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis stroke={COR_EIXO} tickLine={false} axisLine={false} fontSize={11} width={30} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: COR_TOOLTIP_BG, border: "none", borderRadius: 2, color: "#fff", fontSize: 12 }} />
                    <Area type="monotone" dataKey="reservas" name="Reservas" stroke={COR_RESERVAS} strokeWidth={2} fill="url(#gReservas)" />
                    <Area type="monotone" dataKey="concluidas" name="Concluídas" stroke={COR_CONCLUIDAS} strokeWidth={2} fill="url(#gConcluidas)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className={`${styles.panel} ${styles.colSpan5}`}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelEyebrow}>Frota · 30 dias</div>
                <h2 className={styles.panelTitle}>Utilização por unidade</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              {utilizacaoOrdenada.length === 0 ? (
                <div className={styles.empty}>Sem dados no período.</div>
              ) : (
                <div className={styles.utilList}>
                  {utilizacaoOrdenada.map((p) => {
                    const corClasse = p.taxaUtilizacao > 70 ? styles.utilBarAlta : p.taxaUtilizacao > 40 ? styles.utilBarMedia : styles.utilBarBaixa;
                    return (
                      <div key={p.plataformaId} className={styles.utilRow}>
                        <div className={styles.utilLabelRow}>
                          <span className={styles.tableMono}>{p.codigo}</span>
                          <span className={styles.tableMono}>{p.taxaUtilizacao}%</span>
                        </div>
                        <div className={styles.utilTrack}>
                          <div className={`${styles.utilFill} ${corClasse}`} style={{ width: `${Math.min(100, p.taxaUtilizacao)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {utilizacaoOrdenada.length > 0 && (
              <div className={styles.panelFooter}>
                <span>Amostra · {utilizacaoOrdenada.length} plataformas</span>
                <span>Média · {mediaUtilizacao}%</span>
              </div>
            )}
          </div>
        </div>
      )}

      {perfil === "admin" && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Consumo · Período</div>
              <h2 className={styles.panelTitle}>Ranking de setores</h2>
            </div>
            <Link href="/relatorios" className={styles.footerLink}>
              Ver relatório completo <ArrowUpRight size={13} strokeWidth={1.75} />
            </Link>
          </div>
          <div className={styles.tableWrap}>
            {!ranking || ranking.length === 0 ? (
              <div className={styles.empty}>Nenhuma reserva no período.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Setor</th>
                    <th>Distribuição</th>
                    <th>Reservas</th>
                    <th>Rejeição</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((s) => (
                    <tr key={s.setorId}>
                      <td>{s.setorNome}</td>
                      <td className={styles.distribuicaoCell}>
                        <span className={styles.distribuicaoTrack}>
                          <span
                            className={styles.distribuicaoFill}
                            style={{ width: maiorRankingSetor > 0 ? `${(s.totalReservas / maiorRankingSetor) * 100}%` : "0%" }}
                          />
                        </span>
                      </td>
                      <td className={styles.tableMono}>{s.totalReservas}</td>
                      <td className={`${styles.tableMono} ${s.taxaRejeicao > 0 ? styles.tableHazard : ""}`}>{s.taxaRejeicao}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className={styles.footer}>
        <span>PlataformaRes · gestão de equipamentos elevatórios · {setorNome ?? "Matriz"}</span>
        <span>Sistema operacional · atualizado às {ultimaSincronizacao}</span>
      </div>
    </section>
  );
}
