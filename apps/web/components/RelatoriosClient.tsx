"use client";

import { useEffect, useState } from "react";
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
import { apiFetch } from "../lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

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

function primeiroDiaDoMes(): string {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-01`;
}
function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

function rotularDistribuicao(itens: ItemDistribuicao[], labels: Record<string, string>) {
  return itens.map((item, indice) => ({
    chave: labels[item.chave] ?? item.chave,
    quantidade: item.quantidade,
    cor: CORES_CATEGORICAS[indice % CORES_CATEGORICAS.length],
  }));
}

export interface RelatoriosClientProps {
  perfil: "admin" | "gestor_setor";
}

type RelatorioTipo = "utilizacao" | "ranking-setores" | "sla-aprovacao" | "seguranca";

export function RelatoriosClient({ perfil }: RelatoriosClientProps) {
  const [dateFrom, setDateFrom] = useState(primeiroDiaDoMes());
  const [dateTo, setDateTo] = useState(hoje());
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [exportando, setExportando] = useState<string | null>(null);

  const [utilizacao, setUtilizacao] = useState<UtilizacaoResposta | null>(null);
  const [sla, setSla] = useState<SlaResposta | null>(null);
  const [ranking, setRanking] = useState<RankingSetorItem[] | null>(null);
  const [seguranca, setSeguranca] = useState<SegurancaResposta | null>(null);

  useEffect(() => {
    let cancelado = false;
    async function carregar() {
      setCarregando(true);
      setErro(null);
      try {
        const query = `dateFrom=${dateFrom}&dateTo=${dateTo}`;
        const promessas: Promise<unknown>[] = [
          apiFetch<UtilizacaoResposta>(`/api/v1/relatorios/utilizacao?${query}`),
          apiFetch<SlaResposta>(`/api/v1/relatorios/sla-aprovacao?${query}`),
        ];
        if (perfil === "admin") {
          promessas.push(apiFetch<{ setores: RankingSetorItem[] }>(`/api/v1/relatorios/ranking-setores?${query}`));
          promessas.push(apiFetch<SegurancaResposta>(`/api/v1/relatorios/seguranca?${query}`));
        }
        const resultados = await Promise.all(promessas);
        if (cancelado) return;
        setUtilizacao(resultados[0] as UtilizacaoResposta);
        setSla(resultados[1] as SlaResposta);
        if (perfil === "admin") {
          setRanking((resultados[2] as { setores: RankingSetorItem[] }).setores);
          setSeguranca(resultados[3] as SegurancaResposta);
        }
      } catch (err) {
        if (!cancelado) setErro(err instanceof Error ? err.message : "Erro ao carregar relatórios.");
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }
    carregar();
    return () => {
      cancelado = true;
    };
  }, [dateFrom, dateTo, perfil]);

  async function exportar(relatorio: RelatorioTipo, formato: "pdf" | "excel") {
    const chave = `${relatorio}-${formato}`;
    setExportando(chave);
    setErro(null);
    try {
      const query = `relatorio=${relatorio}&formato=${formato}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
      const response = await fetch(`${API_URL}/api/v1/relatorios/export?${query}`, { credentials: "include" });
      if (!response.ok) throw new Error("Erro ao exportar relatório.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `relatorio_${relatorio}_${dateFrom}_a_${dateTo}.${formato === "excel" ? "xlsx" : "pdf"}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao exportar relatório.");
    } finally {
      setExportando(null);
    }
  }

  function BotoesExportacao({ relatorio }: { relatorio: RelatorioTipo }) {
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

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Relatórios & Indicadores</h1>
          <p>{perfil === "admin" ? "Visão global — todos os setores" : "Visão do seu setor"}</p>
        </div>
      </div>

      <div className={styles.periodBar}>
        <div className={styles.periodField}>
          <label>Período — de</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className={styles.periodField}>
          <label>até</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      {carregando ? (
        <div className={styles.loading}>Carregando indicadores...</div>
      ) : (
        <>
          <div className={styles.kpiGrid}>
            <div className={styles.kpiCard}>
              <span className={styles.kpiValue}>{utilizacaoMedia}%</span>
              <span className={styles.kpiLabel}>Utilização Média das Plataformas</span>
            </div>
            <div className={styles.kpiCard}>
              <span className={styles.kpiValue}>
                {sla?.tempoMedioAprovacaoHoras !== null && sla?.tempoMedioAprovacaoHoras !== undefined
                  ? `${sla.tempoMedioAprovacaoHoras}h`
                  : "—"}
              </span>
              <span className={styles.kpiLabel}>Tempo Médio de Aprovação</span>
            </div>
            <div className={styles.kpiCard}>
              <span className={styles.kpiValue}>{sla?.totalDecisoes ?? 0}</span>
              <span className={styles.kpiLabel}>Decisões no Período</span>
            </div>
            {perfil === "admin" && seguranca && (
              <div className={styles.kpiCard}>
                <span className={styles.kpiValue}>{seguranca.percentualChecklistNaoConforme}%</span>
                <span className={styles.kpiLabel}>Checklists Não Conformes</span>
              </div>
            )}
          </div>

          <div className={styles.panelGrid}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Taxa de Utilização por Plataforma</h2>
                <BotoesExportacao relatorio="utilizacao" />
              </div>
              <div className={styles.panelBody}>
                {!utilizacao || utilizacao.plataformas.length === 0 ? (
                  <div className={styles.empty}>Nenhuma plataforma no período.</div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={Math.max(180, utilizacao.plataformas.length * 34)}>
                      <BarChart data={utilizacao.plataformas} layout="vertical" margin={{ left: 8, right: 24 }}>
                        <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                        <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: "#898781" }} />
                        <YAxis
                          type="category"
                          dataKey="codigo"
                          width={90}
                          tick={{ fontSize: 11, fill: "#898781" }}
                        />
                        <Tooltip
                          formatter={(valor: number) => [`${valor}%`, "Utilização"]}
                          labelFormatter={(_, payload) => payload?.[0]?.payload?.nome ?? ""}
                        />
                        <Bar dataKey="taxaUtilizacao" fill={COR_SEQUENCIAL} radius={[0, 4, 4, 0]} maxBarSize={22} />
                      </BarChart>
                    </ResponsiveContainer>
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
                        {utilizacao.plataformas.map((p) => (
                          <tr key={p.plataformaId}>
                            <td>{p.nome}</td>
                            <td>{p.horasDisponiveis}</td>
                            <td>{p.horasReservadas}</td>
                            <td>{p.taxaUtilizacao}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Tendência Mensal de Reservas</h2>
                <BotoesExportacao relatorio="sla-aprovacao" />
              </div>
              <div className={styles.panelBody}>
                {!sla || sla.tendenciaMensal.length === 0 ? (
                  <div className={styles.empty}>Sem dados de tendência no período.</div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={sla.tendenciaMensal} margin={{ left: -12, right: 16 }}>
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
                )}
              </div>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Distribuição por Status</h2>
              </div>
              <div className={styles.panelBody}>
                {!sla ? (
                  <div className={styles.empty}>—</div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={rotularDistribuicao(sla.porStatus, STATUS_LABELS)} margin={{ left: -20 }}>
                      <CartesianGrid vertical={false} stroke="#e1e0d9" />
                      <XAxis dataKey="chave" tick={{ fontSize: 10, fill: "#898781" }} interval={0} angle={-20} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 11, fill: "#898781" }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="quantidade" radius={[4, 4, 0, 0]} maxBarSize={36}>
                        {rotularDistribuicao(sla.porStatus, STATUS_LABELS).map((entrada) => (
                          <Cell key={entrada.chave} fill={entrada.cor} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Distribuição por Prioridade e Categoria</h2>
              </div>
              <div className={styles.panelBody}>
                {!sla ? (
                  <div className={styles.empty}>—</div>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart
                        data={rotularDistribuicao(sla.porPrioridade, PRIORIDADE_LABELS)}
                        layout="vertical"
                        margin={{ left: 8, right: 16 }}
                      >
                        <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "#898781" }} />
                        <YAxis type="category" dataKey="chave" width={64} tick={{ fontSize: 11, fill: "#898781" }} />
                        <Tooltip />
                        <Bar dataKey="quantidade" radius={[0, 4, 4, 0]} maxBarSize={18}>
                          {rotularDistribuicao(sla.porPrioridade, PRIORIDADE_LABELS).map((entrada) => (
                            <Cell key={entrada.chave} fill={entrada.cor} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart
                        data={rotularDistribuicao(sla.porCategoria, CATEGORIA_LABELS)}
                        layout="vertical"
                        margin={{ left: 8, right: 16 }}
                      >
                        <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "#898781" }} />
                        <YAxis type="category" dataKey="chave" width={72} tick={{ fontSize: 11, fill: "#898781" }} />
                        <Tooltip />
                        <Bar dataKey="quantidade" radius={[0, 4, 4, 0]} maxBarSize={18}>
                          {rotularDistribuicao(sla.porCategoria, CATEGORIA_LABELS).map((entrada) => (
                            <Cell key={entrada.chave} fill={entrada.cor} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </>
                )}
              </div>
            </div>

            {perfil === "admin" && (
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Ranking de Setores</h2>
                  <BotoesExportacao relatorio="ranking-setores" />
                </div>
                <div className={styles.panelBody}>
                  {!ranking || ranking.length === 0 ? (
                    <div className={styles.empty}>Nenhuma reserva no período.</div>
                  ) : (
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
                        {ranking.map((s) => (
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
                  )}
                </div>
              </div>
            )}

            {perfil === "admin" && (
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <h2>Indicadores de Segurança</h2>
                  <BotoesExportacao relatorio="seguranca" />
                </div>
                <div className={styles.panelBody}>
                  {!seguranca || seguranca.ocorrenciasPorPlataforma.length === 0 ? (
                    <div className={styles.empty}>Nenhuma ocorrência registrada no período.</div>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={Math.max(160, seguranca.ocorrenciasPorPlataforma.length * 38)}>
                        <BarChart data={seguranca.ocorrenciasPorPlataforma} layout="vertical" margin={{ left: 8, right: 16 }}>
                          <CartesianGrid horizontal={false} stroke="#e1e0d9" />
                          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#898781" }} />
                          <YAxis type="category" dataKey="plataformaNome" width={110} tick={{ fontSize: 11, fill: "#898781" }} />
                          <Tooltip />
                          <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
                          <Bar dataKey="baixa" name="Baixa" stackId="g" fill={CORES_GRAVIDADE.baixa} />
                          <Bar dataKey="media" name="Média" stackId="g" fill={CORES_GRAVIDADE.media} />
                          <Bar dataKey="alta" name="Alta" stackId="g" fill={CORES_GRAVIDADE.alta} radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
