"use client";

import { useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch } from "../lib/api";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { ChecklistSeguranca } from "./ChecklistSeguranca";

// S8 (RN-RES-12): categorias de plataforma cujo checklist de segurança é obrigatório
// antes de "em_uso" — mantido em espelho do backend (checklist.service.ts, requerChecklist)
// só para a UI decidir se deve bloquear o botão "Iniciar Uso"; o backend revalida sempre.
const CATEGORIAS_COM_CHECKLIST_OBRIGATORIO = ["elevatoria", "andaime"];

export interface ReservaDetalhe {
  id: string;
  setorId: string;
  setorNome: string;
  solicitanteNome: string;
  plataformaNome: string;
  plataformaCategoria: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  motivo: string;
  prioridade: "normal" | "alta" | "urgente";
  status: string;
  aprovadoPorNome: string | null;
  segundaAprovacaoPorNome: string | null;
  motivoRejeicao: string | null;
  horaInicioReal: string | null;
  horaFimReal: string | null;
  // S9 (RF-RES-03): presente quando a reserva faz parte de uma série semanal.
  recorrenciaId?: string | null;
  criadoEm: string;
}

interface ReservaDetalheModalProps {
  reserva: ReservaDetalhe;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
  onClose: () => void;
  onAtualizado: () => Promise<void>;
  onCancelarSerie?: (recorrenciaId: string) => Promise<void>;
}

function formatarData(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function ReservaDetalheModal({
  reserva,
  perfil,
  setorId,
  onClose,
  onAtualizado,
  onCancelarSerie,
}: ReservaDetalheModalProps) {
  const [executando, setExecutando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [mostrarFormRejeicao, setMostrarFormRejeicao] = useState(false);
  const [motivoRejeicao, setMotivoRejeicao] = useState("");
  const [checklistTodosConformes, setChecklistTodosConformes] = useState<boolean | null>(null);

  // S7 (RN-RES-07/08): Admin não tem restrição de escopo; Gestor de Setor só age em
  // reservas do próprio setor e, para aprovar, só quando ainda não deu sua própria
  // aprovação (RN-RES-08 — dupla aprovação já em andamento, aguardando o Admin).
  const noEscopo = perfil === "admin" || reserva.setorId === setorId;
  const ehAprovador = perfil === "admin" || perfil === "gestor_setor";
  const podeAprovarRejeitar =
    ehAprovador &&
    noEscopo &&
    reserva.status === "pendente" &&
    !(perfil === "gestor_setor" && reserva.aprovadoPorNome !== null);
  // RF-RES-10/RN-RES-12: plataforma elevatória/andaime só inicia uso com checklist
  // aprovado (todosConformes === true). Enquanto o checklist ainda carrega (null),
  // deixamos o backend ser o árbitro final — o botão some se a chamada retornar bloqueio.
  const exigeChecklist = CATEGORIAS_COM_CHECKLIST_OBRIGATORIO.includes(reserva.plataformaCategoria);
  const checklistLiberaUso = !exigeChecklist || checklistTodosConformes === true;
  const podeIniciarUso = ehAprovador && noEscopo && reserva.status === "agendada" && checklistLiberaUso;
  const podeConcluir = ehAprovador && noEscopo && reserva.status === "em_uso";
  const podeCancelar = ["pendente", "agendada", "em_uso"].includes(reserva.status) && noEscopo;
  // S9 (RF-RES-03): "Cancelar série" só faz sentido enquanto a própria ocorrência ainda
  // está pendente/agendada — em_uso/concluída/etc. já saíram do fluxo de agendamento.
  const podeCancelarSerie =
    Boolean(reserva.recorrenciaId) &&
    Boolean(onCancelarSerie) &&
    ["pendente", "agendada"].includes(reserva.status) &&
    noEscopo;
  const checklistSomenteLeitura = !noEscopo || ["concluida", "cancelada", "rejeitada"].includes(reserva.status);

  async function executarAcao(fn: () => Promise<void>) {
    setErro(null);
    setExecutando(true);
    try {
      await fn();
      await onAtualizado();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao executar ação.");
    } finally {
      setExecutando(false);
    }
  }

  function aprovar() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/aprovar`, { method: "POST", body: JSON.stringify({}) })
    );
  }

  function confirmarRejeicao() {
    if (motivoRejeicao.trim().length < 5) {
      setErro("Informe um motivo com no mínimo 5 caracteres.");
      return;
    }
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/rejeitar`, {
        method: "POST",
        body: JSON.stringify({ motivo: motivoRejeicao.trim() }),
      })
    );
  }

  function iniciarUso() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "iniciar_uso" }),
      })
    );
  }

  function concluir() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "concluir" }),
      })
    );
  }

  function cancelar() {
    if (!confirm("Confirma o cancelamento desta reserva?")) return;
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/cancelar`, { method: "POST", body: JSON.stringify({}) })
    );
  }

  function cancelarSerie() {
    if (!reserva.recorrenciaId || !onCancelarSerie) return;
    return executarAcao(() => onCancelarSerie(reserva.recorrenciaId!));
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
          <h3>Detalhe da Reserva</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={styles.modalBody}>
          {erro && <div className={styles.error}>{erro}</div>}
          <div className={styles.formGrid}>
            <div className={styles.formGroup}>
              <label>Status</label>
              <div>
                <ReservaStatusBadge status={reserva.status} />
              </div>
            </div>
            <div className={styles.formGroup}>
              <label>Prioridade</label>
              <div>
                <PriorityBadge prioridade={reserva.prioridade} />
              </div>
            </div>
            <div className={styles.formGroup}>
              <label>Setor</label>
              <span>{reserva.setorNome}</span>
            </div>
            <div className={styles.formGroup}>
              <label>Responsável</label>
              <span>{reserva.solicitanteNome}</span>
            </div>
            <div className={styles.formGroup}>
              <label>Plataforma</label>
              <span>{reserva.plataformaNome}</span>
            </div>
            <div className={styles.formGroup}>
              <label>Data</label>
              <span>{formatarData(reserva.data)}</span>
            </div>
            <div className={styles.formGroup}>
              <label>Horário</label>
              <span>{reserva.horaInicio} – {reserva.horaFim}</span>
            </div>
            {reserva.aprovadoPorNome && (
              <div className={styles.formGroup}>
                <label>{reserva.status === "pendente" ? "1ª aprovação (Gestor)" : "Aprovado por"}</label>
                <span>{reserva.aprovadoPorNome}</span>
              </div>
            )}
            {reserva.segundaAprovacaoPorNome && (
              <div className={styles.formGroup}>
                <label>2ª aprovação (Admin)</label>
                <span>{reserva.segundaAprovacaoPorNome}</span>
              </div>
            )}
            {reserva.status === "pendente" && reserva.aprovadoPorNome && (
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  Aguardando a segunda aprovação do Admin (RN-RES-08 — prioridade urgente ou plataforma de risco alto).
                </span>
              </div>
            )}
            {reserva.horaInicioReal && (
              <div className={styles.formGroup}>
                <label>Início real</label>
                <span>{reserva.horaInicioReal}</span>
              </div>
            )}
            {reserva.horaFimReal && (
              <div className={styles.formGroup}>
                <label>Fim real</label>
                <span>{reserva.horaFimReal}</span>
              </div>
            )}
            <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
              <label>Motivo / Descrição</label>
              <span>{reserva.motivo}</span>
            </div>
            {reserva.motivoRejeicao && (
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <label>Motivo da rejeição</label>
                <span>{reserva.motivoRejeicao}</span>
              </div>
            )}
          </div>

          {["agendada", "em_uso", "concluida"].includes(reserva.status) && (
            <ChecklistSeguranca
              reservaId={reserva.id}
              somenteLeitura={checklistSomenteLeitura}
              onAtualizado={setChecklistTodosConformes}
            />
          )}
          {exigeChecklist && reserva.status === "agendada" && !checklistLiberaUso && (
            <p style={{ color: "var(--red)", fontSize: "0.8rem", marginTop: 8 }}>
              O botão &quot;Iniciar Uso&quot; fica bloqueado até o checklist de segurança acima ser preenchido com
              todos os itens obrigatórios conformes (RN-RES-12).
            </p>
          )}

          {mostrarFormRejeicao && (
            <div className={styles.formGroup} style={{ marginTop: 14 }}>
              <label htmlFor="motivo-rejeicao">Motivo da rejeição *</label>
              <textarea
                id="motivo-rejeicao"
                rows={2}
                value={motivoRejeicao}
                onChange={(e) => setMotivoRejeicao(e.target.value)}
                placeholder="Explique por que a reserva está sendo rejeitada..."
              />
            </div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            Fechar
          </button>
          {podeAprovarRejeitar && !mostrarFormRejeicao && (
            <>
              <button
                type="button"
                className={styles.btnGhost}
                disabled={executando}
                onClick={() => setMostrarFormRejeicao(true)}
              >
                Rejeitar
              </button>
              <button type="button" className={styles.btnPrimary} disabled={executando} onClick={aprovar}>
                Aprovar
              </button>
            </>
          )}
          {mostrarFormRejeicao && (
            <>
              <button
                type="button"
                className={styles.btnGhost}
                disabled={executando}
                onClick={() => setMostrarFormRejeicao(false)}
              >
                Voltar
              </button>
              <button type="button" className={styles.btnPrimary} disabled={executando} onClick={confirmarRejeicao}>
                Confirmar Rejeição
              </button>
            </>
          )}
          {podeIniciarUso && (
            <button type="button" className={styles.btnPrimary} disabled={executando} onClick={iniciarUso}>
              Iniciar Uso
            </button>
          )}
          {podeConcluir && (
            <button type="button" className={styles.btnPrimary} disabled={executando} onClick={concluir}>
              Concluir
            </button>
          )}
          {podeCancelar && !mostrarFormRejeicao && (
            <button type="button" className={styles.btnDanger} disabled={executando} onClick={cancelar}>
              Cancelar Reserva
            </button>
          )}
          {podeCancelarSerie && !mostrarFormRejeicao && (
            <button type="button" className={styles.btnDanger} disabled={executando} onClick={cancelarSerie}>
              Cancelar Série
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
