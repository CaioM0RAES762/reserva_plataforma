"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "../app/(app)/plataformas/page.module.css";
import { apiFetch } from "../lib/api";

interface Bloqueio {
  id: string;
  plataformaId: string | null;
  plataformaNome: string | null;
  dataInicio: string;
  dataFim: string;
  motivo: string;
  criadoPorNome: string;
  criadoEm: string;
}

interface PlataformaOpcao {
  id: string;
  nome: string;
}

interface ReservaConflitante {
  id: string;
  setorNome: string;
  plataformaNome: string;
  data: string;
  horaInicio: string;
  horaFim: string;
}

type CriarBloqueioResposta = Bloqueio | { requerConfirmacao: true; reservasConflitantes: ReservaConflitante[] };

function formatarDataHora(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Converte um valor ISO (UTC, ex. "2026-08-10T00:00:00.000Z") no formato aceito por
// <input type="datetime-local"> (sem timezone/segundos).
function paraDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

export function BloqueiosClient() {
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [plataformas, setPlataformas] = useState<PlataformaOpcao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [modalAberto, setModalAberto] = useState(false);

  const [plataformaId, setPlataformaId] = useState("");
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [conflitantes, setConflitantes] = useState<ReservaConflitante[] | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const [dadosBloqueios, dadosPlataformas] = await Promise.all([
        apiFetch<Bloqueio[]>("/api/v1/bloqueios"),
        apiFetch<PlataformaOpcao[]>("/api/v1/plataformas"),
      ]);
      setBloqueios(dadosBloqueios);
      setPlataformas(dadosPlataformas);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar bloqueios.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function abrirModal() {
    setPlataformaId("");
    setDataInicio("");
    setDataFim("");
    setMotivo("");
    setConflitantes(null);
    setErroForm(null);
    setModalAberto(true);
  }

  async function enviar(confirmar: boolean) {
    setErroForm(null);
    setSalvando(true);
    try {
      const resposta = await apiFetch<CriarBloqueioResposta>("/api/v1/bloqueios", {
        method: "POST",
        body: JSON.stringify({
          plataformaId: plataformaId || null,
          dataInicio,
          dataFim,
          motivo: motivo.trim(),
          confirmar,
        }),
      });
      if ("requerConfirmacao" in resposta) {
        setConflitantes(resposta.reservasConflitantes);
        return;
      }
      setModalAberto(false);
      await carregar();
    } catch (err) {
      setErroForm(err instanceof Error ? err.message : "Erro ao criar bloqueio.");
    } finally {
      setSalvando(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dataInicio || !dataFim || !motivo.trim()) {
      setErroForm("Preencha todos os campos obrigatórios.");
      return;
    }
    await enviar(false);
  }

  async function handleRemover(bloqueio: Bloqueio) {
    if (!confirm(`Remover o bloqueio "${bloqueio.motivo}"?`)) return;
    setErro(null);
    try {
      await apiFetch(`/api/v1/bloqueios/${bloqueio.id}`, { method: "DELETE" });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao remover bloqueio.");
    }
  }

  const agora = Date.now();

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Bloqueios de Agenda</h1>
          <p>Manutenção preventiva, feriados e paradas programadas</p>
        </div>
        <button className={styles.btnPrimary} onClick={abrirModal}>
          Novo Bloqueio
        </button>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Plataforma</th>
              <th>Início</th>
              <th>Fim</th>
              <th>Motivo</th>
              <th>Criado por</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : bloqueios.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  Nenhum bloqueio cadastrado.
                </td>
              </tr>
            ) : (
              bloqueios.map((b) => {
                const futuro = new Date(b.dataInicio).getTime() > agora;
                return (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.plataformaNome ?? "Global (todas as plataformas)"}</strong>
                    </td>
                    <td>{formatarDataHora(b.dataInicio)}</td>
                    <td>{formatarDataHora(b.dataFim)}</td>
                    <td>{b.motivo}</td>
                    <td>{b.criadoPorNome}</td>
                    <td>
                      {futuro ? (
                        <button className={styles.btnGhost} onClick={() => handleRemover(b)}>
                          Remover
                        </button>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Já iniciado</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalAberto && (
        <div
          className={styles.modalOverlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) setModalAberto(false);
          }}
        >
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h3>Novo Bloqueio de Agenda</h3>
              <button type="button" className={styles.modalClose} onClick={() => setModalAberto(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className={styles.modalBody}>
                {erroForm && <div className={styles.error}>{erroForm}</div>}
                <div className={styles.formGrid}>
                  <div className={styles.formGroup}>
                    <label htmlFor="bl-plataforma">Plataforma</label>
                    <select id="bl-plataforma" value={plataformaId} onChange={(e) => setPlataformaId(e.target.value)}>
                      <option value="">Global (todas as plataformas)</option>
                      {plataformas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nome}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor="bl-inicio">Início *</label>
                    <input
                      id="bl-inicio"
                      type="datetime-local"
                      value={dataInicio}
                      onChange={(e) => setDataInicio(e.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor="bl-fim">Fim *</label>
                    <input
                      id="bl-fim"
                      type="datetime-local"
                      value={dataFim}
                      onChange={(e) => setDataFim(e.target.value)}
                      required
                    />
                  </div>
                  <div className={`${styles.formGroup}`} style={{ gridColumn: "1 / -1" }}>
                    <label htmlFor="bl-motivo">Motivo *</label>
                    <textarea
                      id="bl-motivo"
                      rows={2}
                      value={motivo}
                      onChange={(e) => setMotivo(e.target.value)}
                      placeholder="Ex.: Parada programada, Feriado, Manutenção preventiva trimestral..."
                      required
                    />
                  </div>
                </div>

                {conflitantes && conflitantes.length > 0 && (
                  <div className={styles.error} style={{ marginTop: 12 }}>
                    <strong>Existem {conflitantes.length} reserva(s) agendada(s)/em uso neste período:</strong>
                    <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                      {conflitantes.map((r) => (
                        <li key={r.id}>
                          {r.plataformaNome} — {r.setorNome} — {r.data} {r.horaInicio}–{r.horaFim}
                        </li>
                      ))}
                    </ul>
                    <p style={{ marginTop: 6 }}>Confirme para criar o bloqueio mesmo assim.</p>
                  </div>
                )}
              </div>
              <div className={styles.modalFooter}>
                <button type="button" className={styles.btnGhost} onClick={() => setModalAberto(false)}>
                  Cancelar
                </button>
                {conflitantes && conflitantes.length > 0 ? (
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    disabled={salvando}
                    onClick={() => enviar(true)}
                  >
                    {salvando ? "Confirmando..." : "Confirmar mesmo assim"}
                  </button>
                ) : (
                  <button type="submit" className={styles.btnPrimary} disabled={salvando}>
                    {salvando ? "Criando..." : "Criar Bloqueio"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
