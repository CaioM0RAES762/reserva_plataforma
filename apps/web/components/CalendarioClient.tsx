"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../app/(app)/calendario/page.module.css";
import { apiFetch } from "../lib/api";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

const HOURS = ["06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20"];
const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

interface Setor {
  id: string;
  nome: string;
  corHex: string;
}

interface CalendarioClientProps {
  perfil: "admin" | "colaborador";
  setorId: string | null;
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

export function CalendarioClient({ perfil, setorId }: CalendarioClientProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [reservas, setReservas] = useState<ReservaDetalhe[]>([]);
  const [setores, setSetores] = useState<Setor[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [reservaSelecionada, setReservaSelecionada] = useState<ReservaDetalhe | null>(null);

  const dias = useMemo(() => getWeekDates(weekOffset), [weekOffset]);
  const hojeIso = useMemo(() => toIsoDate(new Date()), []);
  const setorPorId = useMemo(() => new Map(setores.map((s) => [s.id, s])), [setores]);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const dateFrom = toIsoDate(dias[0]);
      const dateTo = toIsoDate(dias[6]);
      const [dadosReservas, dadosSetores] = await Promise.all([
        apiFetch<ReservaDetalhe[]>(`/api/v1/reservas?dateFrom=${dateFrom}&dateTo=${dateTo}`),
        apiFetch<Setor[]>("/api/v1/setores"),
      ]);
      setReservas(dadosReservas);
      setSetores(dadosSetores);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar calendário.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias]);

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset]);

  function changeWeek(dir: number) {
    setWeekOffset((atual) => atual + dir);
  }

  function goToToday() {
    setWeekOffset(0);
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Calendário</h1>
          <p>Visualize a agenda de reservas por semana</p>
        </div>
        <div className={styles.calNav}>
          <button className={styles.btnOutline} onClick={() => changeWeek(-1)} aria-label="Semana anterior">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className={styles.weekLabel}>
            {formatarLabel(dias[0])} – {formatarLabel(dias[6])}
          </span>
          <button className={styles.btnOutline} onClick={() => changeWeek(1)} aria-label="Próxima semana">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button className={styles.btnOutline} onClick={goToToday}>
            Hoje
          </button>
        </div>
      </div>

      {erro && <div style={{ color: "var(--red)", marginBottom: 12, fontSize: "0.85rem" }}>{erro}</div>}

      <div className={styles.calLegend}>
        {setores.map((s) => (
          <div key={s.id} className={styles.calLegendItem}>
            <div className={styles.calLegendDot} style={{ background: s.corHex }} />
            {s.nome}
          </div>
        ))}
      </div>

      <div className={styles.calGridWrap}>
        <div className={styles.calGrid}>
          <div className={styles.calTimeLabel} style={{ background: "var(--surface-2)" }} />
          {dias.map((d, i) => {
            const isToday = toIsoDate(d) === hojeIso;
            return (
              <div key={i} className={`${styles.calHeaderCell} ${isToday ? styles.today : ""}`}>
                {DAY_NAMES[d.getDay()]}
                <span className={`${styles.calHeaderDate} ${isToday ? styles.today : ""}`}>{d.getDate()}</span>
              </div>
            );
          })}

          {HOURS.map((h) => (
            <div key={h} style={{ display: "contents" }}>
              <div className={styles.calTimeLabel}>{h}:00</div>
              {dias.map((d, i) => {
                const dateStr = toIsoDate(d);
                const isToday = dateStr === hojeIso;
                const eventosAqui = reservas.filter((r) => {
                  if (r.status === "cancelada") return false;
                  if (r.data !== dateStr) return false;
                  return r.horaInicio.slice(0, 2) === h;
                });
                return (
                  <div key={i} className={`${styles.calCell} ${isToday ? styles.today : ""}`}>
                    {eventosAqui.map((r) => {
                      const setor = setorPorId.get(r.setorId);
                      const cor = setor?.corHex ?? "#64748B";
                      return (
                        <button
                          key={r.id}
                          type="button"
                          className={styles.calEvent}
                          style={{ background: `${cor}22`, borderLeftColor: cor, color: cor }}
                          title={`${r.setorNome} · ${r.plataformaNome} · ${r.horaInicio}–${r.horaFim}`}
                          onClick={() => setReservaSelecionada(r)}
                        >
                          <div className={styles.calEventPlatform}>{r.plataformaNome}</div>
                          <div className={styles.calEventSector}>{r.setorNome}</div>
                          <div style={{ opacity: 0.7, fontSize: "0.65rem" }}>
                            {r.horaInicio}–{r.horaFim}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

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
