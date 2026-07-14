"use client";

import { useEffect, useState, type FormEvent } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch } from "../lib/api";

export interface ReservaFormValues {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  motivo: string;
  prioridade: "normal" | "alta" | "urgente";
  recorrencia?: { quantidadeOcorrencias: number };
  // S14 (RF-RES-01): só preenchido quando quem solicita é Admin (sem setor_id próprio,
  // RN-USR-01) — ver seletor de "Setor Solicitante" mais abaixo.
  setorId?: string;
}

interface PlataformaOpcao {
  id: string;
  nome: string;
  status: string;
}

interface SetorOpcao {
  id: string;
  nome: string;
}

interface ConflitoResposta {
  conflito: boolean;
  motivo: string | null;
  reserva: { id: string; setorNome: string; horaInicio: string; horaFim: string } | null;
}

// RF-RES-13 ("Reservar novamente"): pré-preenche plataforma/motivo/prioridade de uma
// reserva concluída/cancelada — deliberadamente SEM data/horário/status, que o usuário
// deve escolher de novo (a data antiga quase sempre já passou).
export interface ReservaValoresIniciais {
  plataformaId: string;
  motivo: string;
  prioridade: "normal" | "alta" | "urgente";
}

interface ReservaModalProps {
  solicitanteNome: string;
  setorNome: string | null;
  onClose: () => void;
  onSalvar: (valores: ReservaFormValues) => Promise<void>;
  valoresIniciais?: ReservaValoresIniciais;
}

function hojeStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ReservaModal({ solicitanteNome, setorNome, onClose, onSalvar, valoresIniciais }: ReservaModalProps) {
  const [plataformas, setPlataformas] = useState<PlataformaOpcao[]>([]);
  const [plataformaId, setPlataformaId] = useState(valoresIniciais?.plataformaId ?? "");
  const [prioridade, setPrioridade] = useState<"normal" | "alta" | "urgente">(valoresIniciais?.prioridade ?? "normal");
  const [data, setData] = useState(hojeStr());
  const [horaInicio, setHoraInicio] = useState("");
  const [horaFim, setHoraFim] = useState("");
  const [motivo, setMotivo] = useState(valoresIniciais?.motivo ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [conflitoMotivo, setConflitoMotivo] = useState<string | null>(null);
  const [horarioInvalido, setHorarioInvalido] = useState(false);
  const [repetirSemanalmente, setRepetirSemanalmente] = useState(false);
  const [quantidadeOcorrencias, setQuantidadeOcorrencias] = useState(4);
  // S14 (RF-RES-01): Admin não tem setor_id de sessão (RN-USR-01) — precisa escolher o
  // setor de destino da reserva. `setorNome === null` é como o resto do app já identifica
  // "sou Admin" nesta tela (ver Sidebar/Topbar).
  const exigeSelecaoDeSetor = setorNome === null;
  const [setores, setSetores] = useState<SetorOpcao[]>([]);
  const [setorSelecionadoId, setSetorSelecionadoId] = useState("");

  useEffect(() => {
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((lista) => setPlataformas(lista.filter((p) => p.status !== "inativa")))
      .catch(() => setPlataformas([]));
  }, []);

  useEffect(() => {
    if (!exigeSelecaoDeSetor) return;
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetores)
      .catch(() => setSetores([]));
  }, [exigeSelecaoDeSetor]);

  useEffect(() => {
    if (!plataformaId || !data || !horaInicio || !horaFim) {
      setConflitoMotivo(null);
      setHorarioInvalido(false);
      return;
    }
    if (horaFim <= horaInicio) {
      setHorarioInvalido(true);
      setConflitoMotivo(null);
      return;
    }
    setHorarioInvalido(false);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ plataformaId, data, horaInicio, horaFim });
        const resposta = await apiFetch<ConflitoResposta>(`/api/v1/reservas/conflitos?${params}`);
        setConflitoMotivo(resposta.conflito ? resposta.motivo : null);
      } catch {
        setConflitoMotivo(null);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [plataformaId, data, horaInicio, horaFim]);

  const bloqueado = horarioInvalido || conflitoMotivo !== null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);

    if (!plataformaId || !data || !horaInicio || !horaFim || !motivo.trim()) {
      setErro("Preencha todos os campos obrigatórios.");
      return;
    }
    if (exigeSelecaoDeSetor && !setorSelecionadoId) {
      setErro("Selecione o setor para o qual a reserva está sendo solicitada.");
      return;
    }
    if (bloqueado) {
      setErro("Não é possível salvar: conflito de horário detectado.");
      return;
    }

    setSalvando(true);
    try {
      await onSalvar({
        plataformaId,
        data,
        horaInicio,
        horaFim,
        motivo: motivo.trim(),
        prioridade,
        recorrencia: repetirSemanalmente ? { quantidadeOcorrencias } : undefined,
        setorId: exigeSelecaoDeSetor ? setorSelecionadoId : undefined,
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar reserva.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div
      className={styles.modalOverlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h3>{valoresIniciais ? "Reservar Novamente" : "Nova Reserva"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && <div className={styles.error}>{erro}</div>}
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label htmlFor="rf-sector">Setor Solicitante {exigeSelecaoDeSetor && "*"}</label>
                {exigeSelecaoDeSetor ? (
                  <select
                    id="rf-sector"
                    value={setorSelecionadoId}
                    onChange={(e) => setSetorSelecionadoId(e.target.value)}
                    required
                  >
                    <option value="">Selecione o setor</option>
                    {setores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nome}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id="rf-sector" value={setorNome ?? "—"} disabled />
                )}
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-responsible">Responsável</label>
                <input id="rf-responsible" value={solicitanteNome} disabled />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-platform">Plataforma *</label>
                <select
                  id="rf-platform"
                  value={plataformaId}
                  onChange={(e) => setPlataformaId(e.target.value)}
                  required
                >
                  <option value="">Selecione a plataforma</option>
                  {plataformas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-priority">Prioridade</label>
                <select
                  id="rf-priority"
                  value={prioridade}
                  onChange={(e) => setPrioridade(e.target.value as ReservaFormValues["prioridade"])}
                >
                  <option value="normal">Normal</option>
                  <option value="alta">Alta</option>
                  <option value="urgente">Urgente</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-date">Data *</label>
                <input
                  id="rf-date"
                  type="date"
                  min={hojeStr()}
                  value={data}
                  onChange={(e) => setData(e.target.value)}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-start">Horário Inicial *</label>
                <input
                  id="rf-start"
                  type="time"
                  value={horaInicio}
                  onChange={(e) => setHoraInicio(e.target.value)}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-end">Horário Final *</label>
                <input
                  id="rf-end"
                  type="time"
                  value={horaFim}
                  onChange={(e) => setHoraFim(e.target.value)}
                  required
                />
              </div>
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <label htmlFor="rf-motive">Motivo / Descrição *</label>
                <textarea
                  id="rf-motive"
                  rows={3}
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Descreva o motivo e detalhes do uso..."
                  required
                />
              </div>
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={repetirSemanalmente}
                    onChange={(e) => setRepetirSemanalmente(e.target.checked)}
                  />
                  Repetir semanalmente
                </label>
                {repetirSemanalmente && (
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <label htmlFor="rf-ocorrencias" style={{ fontSize: "0.8rem" }}>
                      Quantidade de ocorrências (2–12)
                    </label>
                    <input
                      id="rf-ocorrencias"
                      type="number"
                      min={2}
                      max={12}
                      value={quantidadeOcorrencias}
                      onChange={(e) =>
                        setQuantidadeOcorrencias(Math.min(12, Math.max(2, Number(e.target.value) || 2)))
                      }
                      style={{ width: 70 }}
                    />
                  </div>
                )}
              </div>
            </div>

            {horarioInvalido && (
              <div className={styles.conflictAlert} id="conflictAlert">
                O horário final deve ser após o horário inicial.
              </div>
            )}
            {!horarioInvalido && conflitoMotivo && (
              <div className={styles.conflictAlert} id="conflictAlert">
                {conflitoMotivo}
              </div>
            )}
          </div>
          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnGhost} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={salvando || bloqueado}>
              {salvando ? "Criando..." : repetirSemanalmente ? "Criar Série" : "Criar Reserva"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
