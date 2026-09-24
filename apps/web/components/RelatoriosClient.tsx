"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "../app/(app)/relatorios/page.module.css";
import { CampoFiltro, FiltrosAvancados } from "./FiltrosAvancados";
import { apiDownload, apiFetch, mensagemDeErro } from "../lib/api";

// Paleta categórica validada (skill dataviz/references/palette.md) — ordem FIXA, nunca
// atribuída por rank/contagem, para que a mesma chave sempre tenha a mesma cor entre
// renders/filtros.
const CORES_CATEGORICAS = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
// Paleta de status (reservada — nunca usada para "série 4"): baixa=good, media=warning, alta=critical.
const CORES_GRAVIDADE: Record<string, string> = { baixa: "#0ca30c", media: "#fab219", alta: "#d03b3b" };
const COR_SEQUENCIAL = "#2563EB"; // --primary do design system do app (magnitude, série única).

const STATUS_LABELS: Record<string, string> = {
  pendente: "Pendente",
  agendada: "Agendada",
  em_uso: "Em Uso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  rejeitada: "Rejeitada",
};
const PRIORIDADE_LABELS: Record<string, string> = { normal: "Normal", alta: "Alta", urgente: "Urgente" };
const CATEGORIA_LABELS: Record<string, string> = {
  elevatoria: "Elevatória",
  andaime: "Andaime",
  sala: "Sala",
  patio: "Pátio",
  veiculo: "Veículo",
  outro: "Outro",
};
const CATEGORIAS_OPCOES = Object.keys(CATEGORIA_LABELS);
const STATUS_NC_LABELS: Record<string, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  resolvida: "Resolvida",
};

// ---------------------------------------------------------------------------
// Formas de resposta da API (espelham packages/shared/src/schemas/relatorio.ts)
// ---------------------------------------------------------------------------

interface ItemDistribuicao {
  chave: string;
  quantidade: number;
}
interface UtilizacaoPlataforma {
  plataformaId: string;
  codigo: string;
  nome: string;
  categoria: string;
  horasDisponiveis: number;
  horasReservadas: number;
  taxaUtilizacao: number;
}
interface UtilizacaoResposta {
  plataformas: UtilizacaoPlataforma[];
}
interface RankingSetorItem {
  setorId: string;
  setorNome: string;
  corHex: string;
  totalReservas: number;
  totalRejeitadas: number;
  taxaRejeicao: number;
}
interface SlaResposta {
  tempoMedioAprovacaoHoras: number | null;
  totalDecisoes: number;
  totalAprovadas: number;
  totalRejeitadas: number;
  taxaAprovacao: number;
  taxaRejeicao: number;
  pendentesAtuais: number;
  porStatus: ItemDistribuicao[];
  porPrioridade: ItemDistribuicao[];
  porCategoria: ItemDistribuicao[];
  tendenciaMensal: { mes: string; quantidade: number }[];
}
interface SegurancaOcorrenciaPlataforma {
  plataformaId: string;
  plataformaNome: string;
  baixa: number;
  media: number;
  alta: number;
  total: number;
}
interface SegurancaResposta {
  totalChecklists: number;
  totalChecklistsNaoConformes: number;
  percentualChecklistNaoConforme: number;
  ocorrenciasPorPlataforma: SegurancaOcorrenciaPlataforma[];
}
interface EvolucaoDiariaItem {
  data: string;
  quantidadeReservas: number;
  horasReservadas: number;
}
interface DemandaPorHoraItem {
  hora: number;
  quantidade: number;
}
interface RankingPlataformaItem {
  plataformaId: string;
  codigo: string;
  nome: string;
  totalReservas: number;
  horasReservadas: number;
}
interface OperacionalResposta {
  totalReservas: number;
  horasReservadasTotais: number;
  totalCanceladas: number;
  taxaCancelamento: number;
  evolucaoDiaria: EvolucaoDiariaItem[];
  demandaPorHora: DemandaPorHoraItem[];
  rankingPlataformas: RankingPlataformaItem[];
}
interface MotivoBloqueioItem {
  motivo: string;
  horasBloqueadas: number;
  ocorrencias: number;
}
interface TendenciaBloqueioItem {
  data: string;
  horasBloqueadas: number;
}
interface BloqueiosResposta {
  horasBloqueadasTotais: number;
  totalBloqueios: number;
  porMotivo: MotivoBloqueioItem[];
  tendencia: TendenciaBloqueioItem[];
}
// Espelha packages/shared/src/schemas/relatorio.ts (naoConformidadesRelatorioRespostaSchema)
// — substitui a antiga aba "Segurança & Checklists". Fonte: Comentario.tipo=
// 'nao_conformidade' + NaoConformidade, nunca ChecklistPreenchido (congelado como
// histórico desde a migration 0018).
interface NaoConformidadeSemanalItem {
  semanaInicio: string;
  total: number;
}
interface NaoConformidadePorSetorItem {
  setorId: string;
  setorNome: string;
  total: number;
}
interface NaoConformidadePorPlataformaItem {
  plataformaId: string;
  plataformaNome: string;
  total: number;
}
interface NaoConformidadePorStatusItem {
  status: "aberta" | "em_analise" | "resolvida";
  total: number;
}
interface NaoConformidadesResposta {
  total: number;
  abertas: number;
  emAnalise: number;
  resolvidas: number;
  taxaResolucao: number | null;
  evolucao: NaoConformidadeSemanalItem[];
  porSetor: NaoConformidadePorSetorItem[];
  porPlataforma: NaoConformidadePorPlataformaItem[];
  porStatus: NaoConformidadePorStatusItem[];
}

interface SetorOpcao {
  id: string;
  nome: string;
}
interface PlataformaOpcao {
  id: string;
  nome: string;
}

function primeiroDiaDoMes(): string {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-01`;
}
function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}
function paraIso(data: Date): string {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
}

type PresetPeriodo = "hoje" | "7dias" | "30dias" | "esteMes" | "mesAnterior";
const PRESETS: { chave: PresetPeriodo; rotulo: string }[] = [
  { chave: "hoje", rotulo: "Hoje" },
  { chave: "7dias", rotulo: "7 dias" },
  { chave: "30dias", rotulo: "30 dias" },
  { chave: "esteMes", rotulo: "Este mês" },
  { chave: "mesAnterior", rotulo: "Mês anterior" },
];

// PARTE 10: atalhos de período — calculados no cliente, sem chamada ao backend.
function calcularPreset(preset: PresetPeriodo): { dateFrom: string; dateTo: string } {
  const agora = new Date();
  if (preset === "hoje") return { dateFrom: paraIso(agora), dateTo: paraIso(agora) };
  if (preset === "7dias") {
    const inicio = new Date(agora);
    inicio.setDate(inicio.getDate() - 6);
    return { dateFrom: paraIso(inicio), dateTo: paraIso(agora) };
  }
  if (preset === "30dias") {
    const inicio = new Date(agora);
    inicio.setDate(inicio.getDate() - 29);
    return { dateFrom: paraIso(inicio), dateTo: paraIso(agora) };
  }
  if (preset === "esteMes") return { dateFrom: primeiroDiaDoMes(), dateTo: hoje() };
  // mesAnterior
  const inicioMesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const fimMesAnterior = new Date(agora.getFullYear(), agora.getMonth(), 0);
  return { dateFrom: paraIso(inicioMesAnterior), dateTo: paraIso(fimMesAnterior) };
}

function rotularDistribuicao(itens: ItemDistribuicao[], labels: Record<string, string>) {
  return itens.map((item, indice) => ({
    chave: labels[item.chave] ?? item.chave,
    quantidade: item.quantidade,
    cor: CORES_CATEGORICAS[indice % CORES_CATEGORICAS.length],
  }));
}

function formatarHoras(valor: number | null): string {
  if (valor === null) return "—";
  return `${valor}h`;
}

// PARTE 30: tooltip customizado — nunca só o número solto, sempre com contexto (nome,
// unidade, participação %).
function TooltipDetalhado({
  active,
  payload,
  montar,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, unknown> }>;
  montar: (dados: Record<string, unknown>) => { titulo: string; linhas: { rotulo: string; valor: string }[] };
}) {
  if (!active || !payload || payload.length === 0) return null;
  const { titulo, linhas } = montar(payload[0].payload);
  return (
    <div className={styles.tooltipCard}>
      <div className={styles.tooltipTitulo}>{titulo}</div>
      {linhas.map((linha) => (
        <div key={linha.rotulo} className={styles.tooltipLinha}>
          <span>{linha.rotulo}</span>
          <strong>{linha.valor}</strong>
        </div>
      ))}
    </div>
  );
}

function EstadoSecao({
  carregando,
  erro,
  vazio,
  children,
}: {
  carregando: boolean;
  erro: string | null;
  vazio: boolean;
  children: React.ReactNode;
}) {
  if (carregando) return <div className={styles.loading}>Carregando...</div>;
  if (erro) return <div className={styles.error}>{erro}</div>;
  if (vazio) return <div className={styles.empty}>Nenhum dado no período.</div>;
  return <>{children}</>;
}

export interface RelatoriosClientProps {
  perfil: "admin" | "gestor_setor";
}

type RelatorioExportavel = "utilizacao" | "ranking-setores" | "sla-aprovacao" | "seguranca";
type AbaRelatorio = "visao-geral" | "frota" | "reservas" | "nao-conformidades" | "indisponibilidade";

// Intervalo vigente em dd/mm ao lado de "Mais filtros": confirma sobre que período os
// gráficos foram calculados sem manter dois campos de data ocupando a barra.
function formatarDataCurtaFiltro(iso: string): string {
  if (!iso) return "—";
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

export function RelatoriosClient({ perfil }: RelatoriosClientProps) {
  // ---------- Filtros globais (PARTE 10) ----------
  const [dateFrom, setDateFrom] = useState(primeiroDiaDoMes());
  const [dateTo, setDateTo] = useState(hoje());
  const [presetAtivo, setPresetAtivo] = useState<PresetPeriodo | null>("esteMes");
  const [setorId, setSetorId] = useState("");
  // Admin e Gestor têm visão GLOBAL (todos os setores por padrão, com filtro de setor
  // opcional). Colaborador não acessa esta tela.
  const visaoGlobal = perfil === "admin" || perfil === "gestor_setor";
  const [plataformaId, setPlataformaId] = useState("");
  const [categoria, setCategoria] = useState("");
  const [setoresOpcoes, setSetoresOpcoes] = useState<SetorOpcao[]>([]);
  const [plataformasOpcoes, setPlataformasOpcoes] = useState<PlataformaOpcao[]>([]);

  const [aba, setAba] = useState<AbaRelatorio>("visao-geral");
  const [exportando, setExportando] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ dateFrom, dateTo });
    if (visaoGlobal && setorId) params.set("setor", setorId);
    if (plataformaId) params.set("plataforma", plataformaId);
    if (categoria) params.set("categoria", categoria);
    return params.toString();
  }, [dateFrom, dateTo, setorId, plataformaId, categoria, perfil]);

  function aplicarPreset(preset: PresetPeriodo) {
    const { dateFrom: novoInicio, dateTo: novoFim } = calcularPreset(preset);
    setDateFrom(novoInicio);
    setDateTo(novoFim);
    setPresetAtivo(preset);
  }

  useEffect(() => {
    if (!visaoGlobal) return;
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetoresOpcoes)
      .catch(() => setSetoresOpcoes([]));
  }, [perfil]);

  useEffect(() => {
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((lista) => setPlataformasOpcoes(lista.map((p) => ({ id: p.id, nome: p.nome }))))
      .catch(() => setPlataformasOpcoes([]));
  }, []);

  // ---------- Dados base: reutilizados por Visão Geral, Uso da Frota e Reservas, uma
  // única carga por mudança de filtro (PARTE 32 — evita disparar tudo de novo por aba). ----------
  const [carregandoBase, setCarregandoBase] = useState(true);
  const [erroBase, setErroBase] = useState<string | null>(null);
  const [utilizacao, setUtilizacao] = useState<UtilizacaoResposta | null>(null);
  const [operacional, setOperacional] = useState<OperacionalResposta | null>(null);
  const [sla, setSla] = useState<SlaResposta | null>(null);
  const [naoConformidades, setNaoConformidades] = useState<NaoConformidadesResposta | null>(null);
  const [seguranca, setSeguranca] = useState<SegurancaResposta | null>(null);

  useEffect(() => {
    let cancelado = false;
    async function carregar() {
      setCarregandoBase(true);
      setErroBase(null);
      try {
        const promessas: Promise<unknown>[] = [
          apiFetch<UtilizacaoResposta>(`/api/v1/relatorios/utilizacao?${query}`),
          apiFetch<OperacionalResposta>(`/api/v1/relatorios/operacional?${query}`),
          apiFetch<SlaResposta>(`/api/v1/relatorios/sla-aprovacao?${query}`),
          // Não Conformidades entra no bundle base (não só na própria aba) porque o card
          // "Taxa de Resolução" da Visão Geral também depende dela.
          apiFetch<NaoConformidadesResposta>(`/api/v1/relatorios/nao-conformidades?${query}`),
        ];
        if (visaoGlobal) {
          promessas.push(apiFetch<SegurancaResposta>(`/api/v1/relatorios/seguranca?${query}`));
        }
        const resultados = await Promise.all(promessas);
        if (cancelado) return;
        setUtilizacao(resultados[0] as UtilizacaoResposta);
        setOperacional(resultados[1] as OperacionalResposta);
        setSla(resultados[2] as SlaResposta);
        setNaoConformidades(resultados[3] as NaoConformidadesResposta);
        if (visaoGlobal) setSeguranca(resultados[4] as SegurancaResposta);
      } catch (err) {
        if (!cancelado) setErroBase(err instanceof Error ? err.message : "Erro ao carregar indicadores.");
      } finally {
        if (!cancelado) setCarregandoBase(false);
      }
    }
    carregar();
    return () => {
      cancelado = true;
    };
  }, [query, perfil]);

  // ---------- Reservas por Setor (RF-REL-02, Admin only) — só carrega quando a aba
  // "Reservas" é aberta. ----------
  const [rankingSetores, setRankingSetores] = useState<RankingSetorItem[] | null>(null);
  const [carregandoSetores, setCarregandoSetores] = useState(false);
  const [erroSetores, setErroSetores] = useState<string | null>(null);

  useEffect(() => {
    if (aba !== "reservas" || !visaoGlobal) return;
    let cancelado = false;
    setCarregandoSetores(true);
    setErroSetores(null);
    apiFetch<{ setores: RankingSetorItem[] }>(`/api/v1/relatorios/ranking-setores?${query}`)
      .then((resposta) => {
        if (!cancelado) setRankingSetores(resposta.setores);
      })
      .catch((err) => {
        if (!cancelado) setErroSetores(mensagemDeErro(err, "Erro ao carregar reservas por setor."));
      })
      .finally(() => {
        if (!cancelado) setCarregandoSetores(false);
      });
    return () => {
      cancelado = true;
    };
  }, [aba, perfil, query]);

  // ---------- Indisponibilidade — só carrega quando a aba correspondente é aberta. ----------
  const [bloqueios, setBloqueios] = useState<BloqueiosResposta | null>(null);
  const [carregandoBloqueios, setCarregandoBloqueios] = useState(false);
  const [erroBloqueios, setErroBloqueios] = useState<string | null>(null);

  useEffect(() => {
    if (aba !== "indisponibilidade") return;
    let cancelado = false;
    setCarregandoBloqueios(true);
    setErroBloqueios(null);
    apiFetch<BloqueiosResposta>(`/api/v1/relatorios/bloqueios?${query}`)
      .then((resposta) => {
        if (!cancelado) setBloqueios(resposta);
      })
      .catch((err) => {
        if (!cancelado) setErroBloqueios(mensagemDeErro(err, "Erro ao carregar indisponibilidade."));
      })
      .finally(() => {
        if (!cancelado) setCarregandoBloqueios(false);
      });
    return () => {
      cancelado = true;
    };
  }, [aba, query]);

  async function exportar(relatorio: RelatorioExportavel, formato: "pdf" | "excel") {
    const chave = `${relatorio}-${formato}`;
    setExportando(chave);
    setErroBase(null);
    try {
      const params = new URLSearchParams({ relatorio, formato, dateFrom, dateTo });
      if (visaoGlobal && setorId) params.set("setor", setorId);
      await apiDownload(
        `/api/v1/relatorios/export?${params}`,
        `relatorio_${relatorio}_${dateFrom}_a_${dateTo}.${formato === "excel" ? "xlsx" : "pdf"}`
      );
    } catch (err) {
      setErroBase(mensagemDeErro(err, "Erro ao exportar relatório."));
    } finally {
      setExportando(null);
    }
  }

  function BotoesExportacao({ relatorio }: { relatorio: RelatorioExportavel }) {
    return (
      <div className={styles.exportGroup}>
        <button
          className={styles.btnExport}
          disabled={exportando !== null}
          onClick={() => exportar(relatorio, "excel")}
        >
          {exportando === `${relatorio}-excel` ? "..." : "Excel"}
        </button>
        <button className={styles.btnExport} disabled={exportando !== null} onClick={() => exportar(relatorio, "pdf")}>
          {exportando === `${relatorio}-pdf` ? "..." : "PDF"}
        </button>
      </div>
    );
  }

  const utilizacaoMedia =
    utilizacao && utilizacao.plataformas.length > 0
      ? Math.round(
          (utilizacao.plataformas.reduce((soma, p) => soma + p.taxaUtilizacao, 0) / utilizacao.plataformas.length) * 100
        ) / 100
      : 0;

  const abas: { chave: AbaRelatorio; rotulo: string }[] = [
    { chave: "visao-geral", rotulo: "Visão Geral" },
    { chave: "frota", rotulo: "Uso da Frota" },
    { chave: "reservas", rotulo: "Reservas" },
    { chave: "nao-conformidades", rotulo: "Não conformidades" },
    { chave: "indisponibilidade", rotulo: "Indisponibilidade" },
  ];

  // Contador do botão "Mais filtros" — período não entra: ele nunca fica "desligado" e
  // já aparece por extenso ao lado do botão.
  const filtrosAvancadosAtivos = [setorId, plataformaId, categoria].filter(Boolean).length;

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Relatórios</h1>
          <p>{setorId ? "Filtrado por setor" : "Visão global — todos os setores"}</p>
        </div>
      </div>

      {/* Sete controles em linha viraram um: os atalhos de período respondem por quase
          todo o uso do relatório, e datas exatas, setor, plataforma e categoria são
          refinamentos que quase ninguém aplica — mas que ocupavam a faixa inteira acima
          dos gráficos, empurrando o primeiro número para fora da primeira dobra. */}
      <FiltrosAvancados
        ativos={filtrosAvancadosAtivos}
        contagem={`${formatarDataCurtaFiltro(dateFrom)} – ${formatarDataCurtaFiltro(dateTo)}`}
        onLimpar={() => {
          setSetorId("");
          setPlataformaId("");
          setCategoria("");
        }}
        avancados={
          <>
            <CampoFiltro label="De" htmlFor="rel-de">
              <input
                id="rel-de"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPresetAtivo(null);
                }}
              />
            </CampoFiltro>
            <CampoFiltro label="Até" htmlFor="rel-ate">
              <input
                id="rel-ate"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPresetAtivo(null);
                }}
              />
            </CampoFiltro>
            {visaoGlobal && (
              <CampoFiltro label="Setor" htmlFor="rel-setor">
                <select id="rel-setor" value={setorId} onChange={(e) => setSetorId(e.target.value)}>
                  <option value="">Todos</option>
                  {setoresOpcoes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome}
                    </option>
                  ))}
                </select>
              </CampoFiltro>
            )}
            <CampoFiltro label="Plataforma" htmlFor="rel-plataforma">
              <select id="rel-plataforma" value={plataformaId} onChange={(e) => setPlataformaId(e.target.value)}>
                <option value="">Todas</option>
                {plataformasOpcoes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
              </select>
            </CampoFiltro>
            <CampoFiltro label="Categoria" htmlFor="rel-categoria">
              <select id="rel-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Todas</option>
                {CATEGORIAS_OPCOES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORIA_LABELS[c]}
                  </option>
                ))}
              </select>
            </CampoFiltro>
          </>
        }
      >
        <div className={styles.presetChips}>
          {PRESETS.map((p) => (
            <button
              key={p.chave}
              type="button"
              className={`${styles.presetChip} ${presetAtivo === p.chave ? styles.presetChipAtivo : ""}`}
              onClick={() => aplicarPreset(p.chave)}
            >
              {p.rotulo}
            </button>
          ))}
        </div>
      </FiltrosAvancados>

      {erroBase && (
        <div className={styles.error} role="alert">
          {erroBase}
        </div>
      )}

      <div className={styles.tabs}>
        {abas.map((a) => (
          <button
            key={a.chave}
            type="button"
            className={`${styles.tab} ${aba === a.chave ? styles.tabAtiva : ""}`}
            onClick={() => setAba(a.chave)}
          >
            {a.rotulo}
          </button>
        ))}
      </div>

      {carregandoBase ? (
        <div className={styles.loading}>Carregando indicadores...</div>
      ) : (
        <>
          {aba === "visao-geral" && (
            <>
              <div className={styles.kpiGrid}>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{utilizacaoMedia}%</span>
                  <span className={styles.kpiLabel}>Utilização Média das Plataformas</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{operacional?.totalReservas ?? 0}</span>
                  <span className={styles.kpiLabel}>Total de Reservas</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{operacional?.horasReservadasTotais ?? 0}h</span>
                  <span className={styles.kpiLabel}>Horas Reservadas</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{operacional?.taxaCancelamento ?? 0}%</span>
                  <span className={styles.kpiLabel}>Taxa de Cancelamento</span>
                  <span className={styles.kpiSub}>{operacional?.totalCanceladas ?? 0} cancelada(s)</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{formatarHoras(sla?.tempoMedioAprovacaoHoras ?? null)}</span>
                  <span className={styles.kpiLabel}>Tempo Médio de Aprovação</span>
                </div>
                {naoConformidades && (
                  <div className={styles.kpiCard}>
                    <span className={styles.kpiValue}>
                      {naoConformidades.taxaResolucao === null ? "—" : `${naoConformidades.taxaResolucao}%`}
                    </span>
                    <span className={styles.kpiLabel}>Taxa de Resolução de NC</span>
                    <span className={styles.kpiSub}>{naoConformidades.total} não conformidade(s)</span>
                  </div>
                )}
              </div>

              <div className={styles.panelGrid}>
                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Reservas ao Longo do Tempo</h2>
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!operacional || operacional.evolucaoDiaria.length === 0}>
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={operacional?.evolucaoDiaria ?? []} margin={{ left: -12, right: 16 }}>
                          <CartesianGrid vertical={false} stroke="#e1e0d9" />
                          <XAxis dataKey="data" tick={{ fontSize: 10, fill: "#898781" }} />
                          <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                          <Tooltip
                            content={
                              <TooltipDetalhado
                                montar={(d) => ({
                                  titulo: String(d.data),
                                  linhas: [
                                    { rotulo: "Reservas", valor: String(d.quantidadeReservas) },
                                    { rotulo: "Horas reservadas", valor: `${d.horasReservadas}h` },
                                  ],
                                })}
                              />
                            }
                          />
                          <Line
                            type="monotone"
                            dataKey="quantidadeReservas"
                            name="Reservas"
                            stroke={COR_SEQUENCIAL}
                            strokeWidth={2}
                            dot={{ r: 3, fill: COR_SEQUENCIAL }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </EstadoSecao>
                  </div>
                </div>

                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Taxa de Utilização por Plataforma</h2>
                    <BotoesExportacao relatorio="utilizacao" />
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!utilizacao || utilizacao.plataformas.length === 0}>
                      <ResponsiveContainer width="100%" height={Math.max(180, (utilizacao?.plataformas.length ?? 0) * 34)}>
                        <BarChart data={utilizacao?.plataformas ?? []} layout="vertical" margin={{ left: 8, right: 24 }}>
                          <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                          <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: "#898781" }} />
                          <YAxis type="category" dataKey="codigo" width={90} tick={{ fontSize: 11, fill: "#898781" }} />
                          <Tooltip
                            content={
                              <TooltipDetalhado
                                montar={(d) => ({
                                  titulo: String(d.nome),
                                  linhas: [
                                    { rotulo: "Utilização", valor: `${d.taxaUtilizacao}%` },
                                    { rotulo: "Horas reservadas", valor: `${d.horasReservadas}h` },
                                    { rotulo: "Horas disponíveis", valor: `${d.horasDisponiveis}h` },
                                  ],
                                })}
                              />
                            }
                          />
                          <Bar dataKey="taxaUtilizacao" fill={COR_SEQUENCIAL} radius={[0, 4, 4, 0]} maxBarSize={22} />
                        </BarChart>
                      </ResponsiveContainer>
                    </EstadoSecao>
                  </div>
                </div>
              </div>
            </>
          )}

          {aba === "frota" && (
            <div className={styles.panelGrid}>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Taxa de Utilização por Plataforma</h2>
                  <BotoesExportacao relatorio="utilizacao" />
                </div>
                <div className={styles.panelBody}>
                  <EstadoSecao carregando={false} erro={null} vazio={!utilizacao || utilizacao.plataformas.length === 0}>
                    <table className={styles.miniTable}>
                      <thead>
                        <tr>
                          <th>Plataforma</th>
                          <th>Disponível (h)</th>
                          <th>Reservada (h)</th>
                          <th>Utilização</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(utilizacao?.plataformas ?? []).map((p) => (
                          <tr key={p.plataformaId}>
                            <td>{p.nome}</td>
                            <td>{p.horasDisponiveis}</td>
                            <td>{p.horasReservadas}</td>
                            <td>{p.taxaUtilizacao}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </EstadoSecao>
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Plataformas Mais Demandadas</h2>
                </div>
                <div className={styles.panelBody}>
                  <EstadoSecao
                    carregando={false}
                    erro={null}
                    vazio={!operacional || operacional.rankingPlataformas.length === 0}
                  >
                    <div className={styles.rankingLista}>
                      {(operacional?.rankingPlataformas ?? []).slice(0, 10).map((p, indice) => (
                        <div key={p.plataformaId} className={styles.rankingItem}>
                          <span className={styles.rankingPosicao}>{indice + 1}.</span>
                          <span className={styles.rankingNome}>{p.nome}</span>
                          <span className={styles.rankingValor}>
                            {p.totalReservas} reserva(s) · {p.horasReservadas}h
                          </span>
                        </div>
                      ))}
                    </div>
                  </EstadoSecao>
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Horários de Maior Demanda</h2>
                </div>
                <div className={styles.panelBody}>
                  <EstadoSecao
                    carregando={false}
                    erro={null}
                    vazio={!operacional || operacional.demandaPorHora.every((h) => h.quantidade === 0)}
                  >
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={operacional?.demandaPorHora ?? []} margin={{ left: -20 }}>
                        <CartesianGrid vertical={false} stroke="#e1e0d9" />
                        <XAxis
                          dataKey="hora"
                          tickFormatter={(h: number) => `${String(h).padStart(2, "0")}h`}
                          tick={{ fontSize: 10, fill: "#898781" }}
                          interval={1}
                        />
                        <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                        <Tooltip
                          content={
                            <TooltipDetalhado
                              montar={(d) => ({
                                titulo: `${String(d.hora).padStart(2, "0")}h`,
                                linhas: [{ rotulo: "Reservas ativas", valor: String(d.quantidade) }],
                              })}
                            />
                          }
                        />
                        <Bar dataKey="quantidade" fill={COR_SEQUENCIAL} radius={[4, 4, 0, 0]} maxBarSize={18} />
                      </BarChart>
                    </ResponsiveContainer>
                  </EstadoSecao>
                </div>
              </div>
            </div>
          )}

          {aba === "reservas" && (
            <>
              <div className={styles.kpiGrid}>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{sla?.taxaAprovacao ?? 0}%</span>
                  <span className={styles.kpiLabel}>Taxa de Aprovação</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{sla?.taxaRejeicao ?? 0}%</span>
                  <span className={styles.kpiLabel}>Taxa de Rejeição</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{sla?.pendentesAtuais ?? 0}</span>
                  <span className={styles.kpiLabel}>Pendentes de Aprovação</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{sla?.totalDecisoes ?? 0}</span>
                  <span className={styles.kpiLabel}>Decisões no Período</span>
                </div>
              </div>

              <div className={styles.panelGrid}>
                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Distribuição por Status</h2>
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!sla}>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={rotularDistribuicao(sla?.porStatus ?? [], STATUS_LABELS)} margin={{ left: -20 }}>
                          <CartesianGrid vertical={false} stroke="#e1e0d9" />
                          <XAxis
                            dataKey="chave"
                            tick={{ fontSize: 10, fill: "#898781" }}
                            interval={0}
                            angle={-20}
                            textAnchor="end"
                            height={50}
                          />
                          <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                          <Tooltip />
                          <Bar dataKey="quantidade" radius={[4, 4, 0, 0]} maxBarSize={36}>
                            {rotularDistribuicao(sla?.porStatus ?? [], STATUS_LABELS).map((entrada) => (
                              <Cell key={entrada.chave} fill={entrada.cor} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </EstadoSecao>
                  </div>
                </div>

                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Tendência Mensal de Reservas</h2>
                    <BotoesExportacao relatorio="sla-aprovacao" />
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!sla || sla.tendenciaMensal.length === 0}>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={sla?.tendenciaMensal ?? []} margin={{ left: -12, right: 16 }}>
                          <CartesianGrid vertical={false} stroke="#e1e0d9" />
                          <XAxis dataKey="mes" tick={{ fontSize: 11, fill: "#898781" }} />
                          <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                          <Tooltip formatter={(valor: number) => [valor, "Reservas"]} />
                          <Line
                            type="monotone"
                            dataKey="quantidade"
                            stroke={COR_SEQUENCIAL}
                            strokeWidth={2}
                            dot={{ r: 4, fill: COR_SEQUENCIAL }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </EstadoSecao>
                  </div>
                </div>

                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Distribuição por Prioridade e Categoria</h2>
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!sla}>
                      <>
                        <ResponsiveContainer width="100%" height={140}>
                          <BarChart
                            data={rotularDistribuicao(sla?.porPrioridade ?? [], PRIORIDADE_LABELS)}
                            layout="vertical"
                            margin={{ left: 8, right: 16 }}
                          >
                            <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "#898781" }} />
                            <YAxis type="category" dataKey="chave" width={64} tick={{ fontSize: 11, fill: "#898781" }} />
                            <Tooltip />
                            <Bar dataKey="quantidade" radius={[0, 4, 4, 0]} maxBarSize={18}>
                              {rotularDistribuicao(sla?.porPrioridade ?? [], PRIORIDADE_LABELS).map((entrada) => (
                                <Cell key={entrada.chave} fill={entrada.cor} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart
                            data={rotularDistribuicao(sla?.porCategoria ?? [], CATEGORIA_LABELS)}
                            layout="vertical"
                            margin={{ left: 8, right: 16 }}
                          >
                            <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "#898781" }} />
                            <YAxis type="category" dataKey="chave" width={72} tick={{ fontSize: 11, fill: "#898781" }} />
                            <Tooltip />
                            <Bar dataKey="quantidade" radius={[0, 4, 4, 0]} maxBarSize={18}>
                              {rotularDistribuicao(sla?.porCategoria ?? [], CATEGORIA_LABELS).map((entrada) => (
                                <Cell key={entrada.chave} fill={entrada.cor} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </>
                    </EstadoSecao>
                  </div>
                </div>

                {visaoGlobal && (
                  <div className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>Reservas por Setor</h2>
                      <BotoesExportacao relatorio="ranking-setores" />
                    </div>
                    <div className={styles.panelBody}>
                      <EstadoSecao
                        carregando={carregandoSetores}
                        erro={erroSetores}
                        vazio={!rankingSetores || rankingSetores.length === 0}
                      >
                        <table className={styles.miniTable}>
                          <thead>
                            <tr>
                              <th>Setor</th>
                              <th>Reservas</th>
                              <th>Rejeitadas</th>
                              <th>Taxa de Rejeição</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(rankingSetores ?? []).map((s) => (
                              <tr key={s.setorId}>
                                <td>
                                  <span className={styles.setorSwatch}>
                                    <span style={{ background: s.corHex }} />
                                    {s.setorNome}
                                  </span>
                                </td>
                                <td>{s.totalReservas}</td>
                                <td>{s.totalRejeitadas}</td>
                                <td>{s.taxaRejeicao}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </EstadoSecao>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {aba === "nao-conformidades" && (
            <>
              <div className={styles.kpiGrid}>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{naoConformidades?.total ?? 0}</span>
                  <span className={styles.kpiLabel}>Total</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{naoConformidades?.abertas ?? 0}</span>
                  <span className={styles.kpiLabel}>Abertas</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{naoConformidades?.emAnalise ?? 0}</span>
                  <span className={styles.kpiLabel}>Em Análise</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{naoConformidades?.resolvidas ?? 0}</span>
                  <span className={styles.kpiLabel}>Resolvidas</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>
                    {naoConformidades?.taxaResolucao === null || naoConformidades?.taxaResolucao === undefined
                      ? "—"
                      : `${naoConformidades.taxaResolucao}%`}
                  </span>
                  <span className={styles.kpiLabel}>Taxa de Resolução</span>
                </div>
              </div>

              <EstadoSecao carregando={carregandoBase} erro={erroBase} vazio={false}>
                <div className={styles.panelGrid}>
                  <div className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>Evolução no Período</h2>
                    </div>
                    <div className={styles.panelBody}>
                      <EstadoSecao
                        carregando={false}
                        erro={null}
                        vazio={!naoConformidades || naoConformidades.evolucao.length === 0}
                      >
                        <ResponsiveContainer width="100%" height={200}>
                          <LineChart data={naoConformidades?.evolucao ?? []} margin={{ left: -12, right: 16 }}>
                            <CartesianGrid vertical={false} stroke="#e1e0d9" />
                            <XAxis dataKey="semanaInicio" tick={{ fontSize: 10, fill: "#898781" }} />
                            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#898781" }} />
                            <Tooltip
                              content={
                                <TooltipDetalhado
                                  montar={(d) => ({
                                    titulo: `Semana de ${d.semanaInicio}`,
                                    linhas: [{ rotulo: "Não conformidades", valor: String(d.total) }],
                                  })}
                                />
                              }
                            />
                            <Line
                              type="monotone"
                              dataKey="total"
                              stroke={CORES_GRAVIDADE.alta}
                              strokeWidth={2}
                              dot={{ r: 4, fill: CORES_GRAVIDADE.alta }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </EstadoSecao>
                    </div>
                  </div>

                  <div className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>Por Setor</h2>
                    </div>
                    <div className={styles.panelBody}>
                      <EstadoSecao
                        carregando={false}
                        erro={null}
                        vazio={!naoConformidades || naoConformidades.porSetor.length === 0}
                      >
                        <ResponsiveContainer width="100%" height={Math.max(140, (naoConformidades?.porSetor.length ?? 0) * 34)}>
                          <BarChart data={naoConformidades?.porSetor ?? []} layout="vertical" margin={{ left: 8, right: 16 }}>
                            <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#898781" }} />
                            <YAxis type="category" dataKey="setorNome" width={110} tick={{ fontSize: 11, fill: "#898781" }} />
                            <Tooltip />
                            <Bar dataKey="total" fill={COR_SEQUENCIAL} radius={[0, 4, 4, 0]} maxBarSize={20} />
                          </BarChart>
                        </ResponsiveContainer>
                      </EstadoSecao>
                    </div>
                  </div>

                  <div className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>Por Plataforma</h2>
                    </div>
                    <div className={styles.panelBody}>
                      <EstadoSecao
                        carregando={false}
                        erro={null}
                        vazio={!naoConformidades || naoConformidades.porPlataforma.length === 0}
                      >
                        <ResponsiveContainer
                          width="100%"
                          height={Math.max(140, (naoConformidades?.porPlataforma.length ?? 0) * 34)}
                        >
                          <BarChart
                            data={naoConformidades?.porPlataforma ?? []}
                            layout="vertical"
                            margin={{ left: 8, right: 16 }}
                          >
                            <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#898781" }} />
                            <YAxis
                              type="category"
                              dataKey="plataformaNome"
                              width={110}
                              tick={{ fontSize: 11, fill: "#898781" }}
                            />
                            <Tooltip />
                            <Bar dataKey="total" fill={CORES_GRAVIDADE.alta} radius={[0, 4, 4, 0]} maxBarSize={20} />
                          </BarChart>
                        </ResponsiveContainer>
                      </EstadoSecao>
                    </div>
                  </div>

                  <div className={styles.panel}>
                    <div className={styles.panelHeader}>
                      <h2>Por Status</h2>
                    </div>
                    <div className={styles.panelBody}>
                      {naoConformidades && (
                        <div className={styles.rankingLista}>
                          {naoConformidades.porStatus.map((item) => (
                            <div key={item.status} className={styles.rankingItem}>
                              <span className={styles.rankingNome}>{STATUS_NC_LABELS[item.status]}</span>
                              <span className={styles.rankingValor}>{item.total}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {visaoGlobal && seguranca && (
                    <div className={styles.panel}>
                      <div className={styles.panelHeader}>
                        <h2>Indicadores de Segurança (Ocorrências)</h2>
                        <BotoesExportacao relatorio="seguranca" />
                      </div>
                      <div className={styles.panelBody}>
                        <EstadoSecao carregando={false} erro={null} vazio={seguranca.ocorrenciasPorPlataforma.length === 0}>
                          <ResponsiveContainer
                            width="100%"
                            height={Math.max(160, seguranca.ocorrenciasPorPlataforma.length * 38)}
                          >
                            <BarChart data={seguranca.ocorrenciasPorPlataforma} layout="vertical" margin={{ left: 8, right: 16 }}>
                              <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#898781" }} />
                              <YAxis type="category" dataKey="plataformaNome" width={110} tick={{ fontSize: 11, fill: "#898781" }} />
                              <Tooltip />
                              <Legend wrapperStyle={{ fontSize: "0.8rem" }} />
                              <Bar dataKey="baixa" name="Baixa" stackId="g" fill={CORES_GRAVIDADE.baixa} />
                              <Bar dataKey="media" name="Média" stackId="g" fill={CORES_GRAVIDADE.media} />
                              <Bar dataKey="alta" name="Alta" stackId="g" fill={CORES_GRAVIDADE.alta} radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </EstadoSecao>
                      </div>
                    </div>
                  )}
                </div>
              </EstadoSecao>
            </>
          )}

          {aba === "indisponibilidade" && (
            <EstadoSecao carregando={carregandoBloqueios} erro={erroBloqueios} vazio={false}>
              <div className={styles.kpiGrid}>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{bloqueios?.horasBloqueadasTotais ?? 0}h</span>
                  <span className={styles.kpiLabel}>Horas Bloqueadas</span>
                  <span className={styles.kpiSub}>soma dos bloqueios registrados no período</span>
                </div>
                <div className={styles.kpiCard}>
                  <span className={styles.kpiValue}>{bloqueios?.totalBloqueios ?? 0}</span>
                  <span className={styles.kpiLabel}>Bloqueios Registrados</span>
                </div>
              </div>

              <div className={styles.panelGrid}>
                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Tendência de Horas Bloqueadas</h2>
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!bloqueios || bloqueios.tendencia.length === 0}>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={bloqueios?.tendencia ?? []} margin={{ left: -12, right: 16 }}>
                          <CartesianGrid vertical={false} stroke="#e1e0d9" />
                          <XAxis dataKey="data" tick={{ fontSize: 10, fill: "#898781" }} />
                          <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                          <Tooltip formatter={(valor: number) => [`${valor}h`, "Horas bloqueadas"]} />
                          <Line
                            type="monotone"
                            dataKey="horasBloqueadas"
                            stroke={CORES_GRAVIDADE.alta}
                            strokeWidth={2}
                            dot={{ r: 3, fill: CORES_GRAVIDADE.alta }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </EstadoSecao>
                  </div>
                </div>

                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <h2>Motivos de Bloqueio</h2>
                  </div>
                  <div className={styles.panelBody}>
                    <EstadoSecao carregando={false} erro={null} vazio={!bloqueios || bloqueios.porMotivo.length === 0}>
                      <div className={styles.miniTableWrap}>
                        <table className={styles.miniTable}>
                          <thead>
                            <tr>
                              <th>Motivo</th>
                              <th>Ocorrências</th>
                              <th>Horas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(bloqueios?.porMotivo ?? []).map((m) => (
                              <tr key={m.motivo}>
                                <td className={styles.miniTableMotivo} title={m.motivo}>
                                  {m.motivo}
                                </td>
                                <td>{m.ocorrencias}</td>
                                <td>{m.horasBloqueadas}h</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </EstadoSecao>
                  </div>
                </div>
              </div>
            </EstadoSecao>
          )}
        </>
      )}
    </section>
  );
}
