"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "../app/(app)/calendario/page.module.css";
import { apiFetch } from "../lib/api";
import { useEventosSSE } from "../lib/useEventosSSE";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";
import { ReservaModal, type ReservaFormValues, type ReservaValoresIniciais } from "./ReservaModal";

const HOURS = ["06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20"];
const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// Grade proporcional: 1 minuto = ROW_HEIGHT_PX/60 pixels — eventos e bloqueios são
// posicionados por horário real (não mais "encaixados" numa célula de hora fixa), então a
// altura de cada bloco reflete a duração de verdade.
const ROW_HEIGHT_PX = 60;
const GRID_START_MIN = Number(HOURS[0]) * 60;
const GRID_END_MIN = (Number(HOURS[HOURS.length - 1]) + 1) * 60;
const GRID_HEIGHT_PX = HOURS.length * ROW_HEIGHT_PX;
const MIN_EVENT_HEIGHT_PX = 22;

interface Setor {
  id: string;
  nome: string;
  corHex: string;
}

interface Bloqueio {
  id: string;
  plataformaId: string | null;
  plataformaNome: string | null;
  dataInicio: string;
  dataFim: string;
  motivo: string;
}

interface CalendarioClientProps {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
  solicitanteNome: string;
  setorNome: string | null;
}

interface TooltipState {
  x: number;
  y: number;
  conteudo: ReactNode;
}

interface EventoPosicionado {
  reserva: ReservaDetalhe;
  top: number;
  height: number;
  col: number;
  totalCols: number;
}

function getWeekDates(offsetWeeks: number): Date[] {
  const now = new Date();
  const day = now.getDay(); // 0 = domingo
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + (day === 0 ? -6 : 1) + offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function toIsoDate(d: Date): string {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function formatarLabel(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function minutosDoHorario(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function topPx(hhmm: string): number {
  const min = Math.min(Math.max(minutosDoHorario(hhmm), GRID_START_MIN), GRID_END_MIN);
  return ((min - GRID_START_MIN) / 60) * ROW_HEIGHT_PX;
}

function heightPx(inicio: string, fim: string): number {
  return Math.max(topPx(fim) - topPx(inicio), MIN_EVENT_HEIGHT_PX);
}

function arredondarParaMeiaHora(minutosTotal: number): number {
  return Math.round(minutosTotal / 30) * 30;
}

function minutosParaHHMM(minutosTotal: number): string {
  const h = Math.floor(minutosTotal / 60);
  const m = minutosTotal % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Algoritmo clássico de layout de agenda: eventos que se sobrepõem no tempo dividem a
// largura da coluna do dia entre si; eventos em clusters diferentes (sem sobreposição)
// cada um ocupa a largura toda.
function posicionarEventosDoDia(eventosDoDia: ReservaDetalhe[]): EventoPosicionado[] {
  const ordenados = [...eventosDoDia].sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
  const resultado: EventoPosicionado[] = [];
  let clusterEventos: { reserva: ReservaDetalhe; col: number }[] = [];
  let colunasFim: number[] = [];
  let clusterFimMax = -1;

  function fecharCluster() {
    const totalCols = colunasFim.length;
    for (const item of clusterEventos) {
      resultado.push({
        reserva: item.reserva,
        top: topPx(item.reserva.horaInicio),
        height: heightPx(item.reserva.horaInicio, item.reserva.horaFim),
        col: item.col,
        totalCols,
      });
    }
    clusterEventos = [];
    colunasFim = [];
    clusterFimMax = -1;
  }

  for (const reserva of ordenados) {
    const inicioMin = minutosDoHorario(reserva.horaInicio);
    const fimMin = minutosDoHorario(reserva.horaFim);
    if (clusterEventos.length > 0 && inicioMin >= clusterFimMax) {
      fecharCluster();
    }
    let colIndex = colunasFim.findIndex((fim) => fim <= inicioMin);
    if (colIndex === -1) {
      colIndex = colunasFim.length;
      colunasFim.push(fimMin);
    } else {
      colunasFim[colIndex] = fimMin;
    }
    clusterEventos.push({ reserva, col: colIndex });
    clusterFimMax = Math.max(clusterFimMax, fimMin);
  }
  fecharCluster();
  return resultado;
}

export function CalendarioClient({ perfil, setorId, solicitanteNome, setorNome }: CalendarioClientProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [reservas, setReservas] = useState<ReservaDetalhe[]>([]);
  const [setores, setSetores] = useState<Setor[]>([]);
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [reservaSelecionada, setReservaSelecionada] = useState<ReservaDetalhe | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [agora, setAgora] = useState(() => new Date());
  const [modalCriarAberto, setModalCriarAberto] = useState(false);
  const [valoresIniciaisCriar, setValoresIniciaisCriar] = useState<ReservaValoresIniciais | undefined>(undefined);
  const primeiraCarga = useRef(true);

  const dias = useMemo(() => getWeekDates(weekOffset), [weekOffset]);
  const hojeIso = useMemo(() => toIsoDate(new Date()), []);
  const setorPorId = useMemo(() => new Map(setores.map((s) => [s.id, s])), [setores]);

  const carregar = useCallback(async () => {
    if (primeiraCarga.current) setCarregando(true);
    setErro(null);
    try {
      const dateFrom = toIsoDate(dias[0]);
      const dateTo = toIsoDate(dias[6]);
      const [dadosReservas, dadosSetores, dadosBloqueios] = await Promise.all([
        apiFetch<ReservaDetalhe[]>(`/api/v1/reservas?dateFrom=${dateFrom}&dateTo=${dateTo}`),
        apiFetch<Setor[]>("/api/v1/setores"),
        apiFetch<Bloqueio[]>("/api/v1/bloqueios"),
      ]);
      setReservas(dadosReservas);
      setSetores(dadosSetores);
      setBloqueios(dadosBloqueios);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar calendário.");
    } finally {
      primeiraCarga.current = false;
      setCarregando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias]);

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset]);

  // Relógio ao vivo para a linha do "agora" — atualiza a cada minuto, sem F5.
  useEffect(() => {
    const timer = setInterval(() => setAgora(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // RNF-10: reservas criadas/aprovadas/alteradas em qualquer outra tela (Fila de
  // Aprovações, Dashboard, outro usuário) refletem aqui sem precisar recarregar a página.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) carregar();
    },
  });

  function changeWeek(dir: number) {
    setWeekOffset((atual) => atual + dir);
  }

  function goToToday() {
    setWeekOffset(0);
  }

  async function handleSalvarNovaReserva(valores: ReservaFormValues) {
    await apiFetch("/api/v1/reservas", { method: "POST", body: JSON.stringify(valores) });
    setModalCriarAberto(false);
    setValoresIniciaisCriar(undefined);
    await carregar();
  }

  function abrirCriacaoRapida(dataIso: string, inicioMin: number) {
    const inicioArredondado = arredondarParaMeiaHora(inicioMin);
    const fimClamp = Math.min(inicioArredondado + 60, GRID_END_MIN);
    setValoresIniciaisCriar({
      plataformaId: "",
      motivo: "",
      prioridade: "normal",
      data: dataIso,
      horaInicio: minutosParaHHMM(inicioArredondado),
      horaFim: minutosParaHHMM(fimClamp),
    });
    setModalCriarAberto(true);
  }

  function mostrarTooltip(event: React.MouseEvent, conteudo: ReactNode) {
    setTooltip({ x: event.clientX, y: event.clientY, conteudo });
  }

  function moverTooltip(event: React.MouseEvent) {
    setTooltip((atual) => (atual ? { ...atual, x: event.clientX, y: event.clientY } : atual));
  }

  const nomeMes = MONTH_NAMES[dias[0].getMonth()];
  const mesLabel = `${nomeMes.charAt(0).toUpperCase()}${nomeMes.slice(1)} de ${dias[0].getFullYear()}`;
  const semanaEhAtual = weekOffset === 0;

  return (
    <section onMouseMove={tooltip ? moverTooltip : undefined}>
      <div className={styles.header}>
        <div>
          <h1>Calendário</h1>
          <p>Visualize a agenda de reservas por semana — clique num horário vazio para criar uma reserva</p>
        </div>
        <button
          className={styles.btnPrimary}
          onClick={() => {
            setValoresIniciaisCriar(undefined);
            setModalCriarAberto(true);
          }}
        >
          + Nova Reserva
        </button>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.calNav}>
          <button className={styles.btnOutline} onClick={() => changeWeek(-1)} aria-label="Semana anterior">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button className={styles.btnOutline} onClick={() => changeWeek(1)} aria-label="Próxima semana">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button className={`${styles.btnOutline} ${semanaEhAtual ? styles.btnOutlineActive : ""}`} onClick={goToToday}>
            Hoje
          </button>
          <div className={styles.weekLabelBlock}>
            <span className={styles.weekLabel}>
              {formatarLabel(dias[0])} – {formatarLabel(dias[6])}
            </span>
            <span className={styles.monthLabel}>{mesLabel}</span>
          </div>
        </div>

        <div className={styles.calLegend}>
          {setores.map((s) => (
            <div key={s.id} className={styles.calLegendChip} style={{ borderColor: `${s.corHex}55`, color: s.corHex, background: `${s.corHex}18` }}>
              <div className={styles.calLegendDot} style={{ background: s.corHex }} />
              {s.nome}
            </div>
          ))}
          <div className={styles.calLegendChip}>
            <div className={`${styles.calLegendDot} ${styles.calCellBlocked}`} />
            Bloqueio de agenda
          </div>
        </div>
      </div>

      {erro && (
              <div className={styles.error} role="alert">
                {erro}
              </div>
            )}

      <div className={styles.calGridWrap}>
        {carregando ? (
          <div className={styles.calSkeleton}>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className={styles.calSkeletonCol} />
            ))}
          </div>
        ) : (
          <div className={styles.calGrid}>
            <div className={styles.calCornerCell} />
            {dias.map((d, i) => {
              const isToday = toIsoDate(d) === hojeIso;
              return (
                <div key={i} className={`${styles.calHeaderCell} ${isToday ? styles.today : ""}`}>
                  {DAY_NAMES[d.getDay()]}
                  <span className={`${styles.calHeaderDate} ${isToday ? styles.today : ""}`}>{d.getDate()}</span>
                </div>
              );
            })}

            <div className={styles.calTimeAxis} style={{ height: GRID_HEIGHT_PX }}>
              {HOURS.map((h, i) => (
                <span key={h} className={styles.calTimeAxisLabel} style={{ top: i * ROW_HEIGHT_PX - 7 }}>
                  {h}:00
                </span>
              ))}
            </div>

            {dias.map((d, dayIndex) => {
              const dateStr = toIsoDate(d);
              const isToday = dateStr === hojeIso;
              const eventosDoDia = reservas.filter((r) => r.status !== "cancelada" && r.data === dateStr);
              const posicionados = posicionarEventosDoDia(eventosDoDia);

              const inicioDiaMs = new Date(`${dateStr}T00:00:00`).getTime();
              const bloqueiosDoDia = bloqueios.filter((b) => {
                const bInicio = new Date(b.dataInicio).getTime();
                const bFim = new Date(b.dataFim).getTime();
                return bInicio < inicioDiaMs + 24 * 60 * 60 * 1000 && bFim > inicioDiaMs;
              });

              const nowMin = agora.getHours() * 60 + agora.getMinutes();
              const mostrarLinhaAgora = isToday && nowMin >= GRID_START_MIN && nowMin <= GRID_END_MIN;

              return (
                <div
                  key={dayIndex}
                  className={`${styles.calDayColumn} ${isToday ? styles.today : ""}`}
                  style={{ height: GRID_HEIGHT_PX }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const offsetY = event.clientY - rect.top;
                    const minutosClicados = GRID_START_MIN + (offsetY / ROW_HEIGHT_PX) * 60;
                    abrirCriacaoRapida(dateStr, minutosClicados);
                  }}
                >
                  {HOURS.map((_, i) => (
                    <div key={i} className={styles.calGridLine} style={{ top: i * ROW_HEIGHT_PX }} />
                  ))}

                  {bloqueiosDoDia.map((b) => {
                    const bInicioMin = Math.max(
                      (new Date(b.dataInicio).getTime() - inicioDiaMs) / 60000,
                      GRID_START_MIN
                    );
                    const bFimMin = Math.min((new Date(b.dataFim).getTime() - inicioDiaMs) / 60000, GRID_END_MIN);
                    if (bFimMin <= GRID_START_MIN || bInicioMin >= GRID_END_MIN) return null;
                    const top = ((bInicioMin - GRID_START_MIN) / 60) * ROW_HEIGHT_PX;
                    const height = Math.max(((bFimMin - bInicioMin) / 60) * ROW_HEIGHT_PX, MIN_EVENT_HEIGHT_PX);
                    return (
                      <div
                        key={b.id}
                        className={styles.calBlockLabel}
                        style={{ top, height }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={(e) =>
                          mostrarTooltip(
                            e,
                            <>
                              <strong>Bloqueio de agenda</strong>
                              <div>{b.plataformaNome ?? "Todas as plataformas"}</div>
                              <div className={styles.tooltipMuted}>{b.motivo}</div>
                            </>
                          )
                        }
                        onMouseLeave={() => setTooltip(null)}
                      >
                        🚫 {b.plataformaNome ?? "Global"}
                      </div>
                    );
                  })}

                  {mostrarLinhaAgora && (
                    <div className={styles.calNowLine} style={{ top: ((nowMin - GRID_START_MIN) / 60) * ROW_HEIGHT_PX }}>
                      <span className={styles.calNowDot} />
                    </div>
                  )}

                  {posicionados.map(({ reserva: r, top, height, col, totalCols }) => {
                    const setor = setorPorId.get(r.setorId);
                    const cor = setor?.corHex ?? "#64748B";
                    const widthPct = 100 / totalCols;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={styles.calEvent}
                        style={{
                          top,
                          height,
                          left: `calc(${col * widthPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          background: `${cor}22`,
                          borderLeftColor: cor,
                          color: cor,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setReservaSelecionada(r);
                        }}
                        onMouseEnter={(e) =>
                          mostrarTooltip(
                            e,
                            <>
                              <strong>{r.plataformaNome}</strong>
                              <div>{r.setorNome} · {r.solicitanteNome}</div>
                              <div className={styles.tooltipMuted}>
                                {r.horaInicio}–{r.horaFim} · {r.motivo}
                              </div>
                            </>
                          )
                        }
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <div className={styles.calEventPlatform}>{r.plataformaNome}</div>
                        {height > 34 && <div className={styles.calEventSector}>{r.setorNome}</div>}
                        {height > 48 && (
                          <div className={styles.calEventTime}>
                            {r.horaInicio}–{r.horaFim}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {tooltip && (
        <div
          className={styles.calTooltip}
          style={{
            left: Math.min(tooltip.x + 16, (typeof window !== "undefined" ? window.innerWidth : 1280) - 240),
            top: Math.min(tooltip.y + 16, (typeof window !== "undefined" ? window.innerHeight : 800) - 100),
          }}
        >
          {tooltip.conteudo}
        </div>
      )}

      {modalCriarAberto && (
        <ReservaModal
          solicitanteNome={solicitanteNome}
          setorNome={setorNome}
          onClose={() => {
            setModalCriarAberto(false);
            setValoresIniciaisCriar(undefined);
          }}
          onSalvar={handleSalvarNovaReserva}
          valoresIniciais={valoresIniciaisCriar}
        />
      )}

      {reservaSelecionada && (
        <ReservaDetalheModal
          reserva={reservaSelecionada}
          perfil={perfil}
          setorId={setorId}
          onClose={() => setReservaSelecionada(null)}
          onAtualizado={async () => {
            setReservaSelecionada(null);
            await carregar();
          }}
        />
      )}
    </section>
  );
}
