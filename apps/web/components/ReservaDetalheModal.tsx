"use client";

import { useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import local from "./ReservaDetalheModal.module.css";
import { apiFetch } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { ChecklistFillModal, type ChecklistResumo } from "./ChecklistFillModal";
import { AnexosComentarios } from "./AnexosComentarios";

// Passo a passo do caminho feliz — cancelada/rejeitada são estados terminais à parte
// (ver terminalBanner) e não aparecem aqui, pois quebram a progressão linear.
//
// "Checklist" só entra quando a reserva exige um (reserva.requerChecklist) — o checklist
// agora é portão da APROVAÇÃO (RN-CHK-03), não mais do início de uso, então a etapa fica
// entre "Solicitada" e "Aprovada". Nenhuma dessas chaves é o `status` real da reserva no
// banco (que continua só pendente/agendada/em_uso/concluida/...) — "checklist" é uma
// sub-fase de status="pendente", distinguida por chaveEtapaAtiva() abaixo usando o estado
// do checklist, não um valor novo de status.
type EtapaChave = "solicitada" | "checklist" | "aprovada" | "em_uso" | "concluida";

function montarEtapas(requerChecklist: boolean): Array<{ chave: EtapaChave; label: string }> {
  const etapas: Array<{ chave: EtapaChave; label: string }> = [{ chave: "solicitada", label: "Solicitada" }];
  if (requerChecklist) etapas.push({ chave: "checklist", label: "Checklist" });
  etapas.push(
    { chave: "aprovada", label: "Aprovada" },
    { chave: "em_uso", label: "Em uso" },
    { chave: "concluida", label: "Concluída" }
  );
  return etapas;
}

function chaveEtapaAtiva(status: string, requerChecklist: boolean, checklistPronto: boolean): EtapaChave {
  if (status === "pendente") {
    return requerChecklist && !checklistPronto ? "checklist" : "aprovada";
  }
  if (status === "agendada") return "aprovada";
  if (status === "em_uso") return "em_uso";
  return "concluida";
}

function IconCalendario() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
function IconRelogio() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}
function IconPlataforma() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
    </svg>
  );
}
function IconPessoa() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}
function IconChecagem() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function IconBandeira() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 21V4M4 4h13l-2.5 4L17 12H4" />
    </svg>
  );
}

export interface ReservaDetalhe {
  id: string;
  setorId: string;
  setorNome: string;
  // Corrigir/melhorar Reservas: usado para destacar "minhas reservas" na listagem —
  // comparação sempre por id, nunca por nome (ver ReservasClient).
  solicitanteId: string;
  solicitanteNome: string;
  plataformaId: string;
  plataformaNome: string;
  plataformaCategoria: string;
  plataformaLocalizacao?: string | null;
  data: string;
  horaInicio: string;
  horaFim: string;
  quantidadePessoas: number;
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
  // Correção do fluxo de Checklist: resolvido pelo backend (template específico da
  // plataforma OU default da categoria) — nunca mais uma lista fixa de categorias no
  // frontend. O checklist é portão da APROVAÇÃO (RN-CHK-03); estes campos só espelham o
  // estado já salvo no momento em que a lista/detalhe foi carregada — o resumo ao vivo
  // (após abrir/editar o checklist neste modal) vem do estado local checklistResumo.
  requerChecklist: boolean;
  checklistFinalizadoEm: string | null;
  checklistTodosConformes: boolean | null;
}

interface ReservaDetalheModalProps {
  reserva: ReservaDetalhe;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
  onClose: () => void;
  onAtualizado: () => Promise<void>;
  onCancelarSerie?: (recorrenciaId: string) => Promise<void>;
  // RF-RES-13 ("Reservar novamente"): reservas concluídas/canceladas oferecem pré-preencher
  // uma nova reserva com os mesmos dados (exceto data/status) — decisão de UI fica no pai
  // (ReservasClient), que já controla a abertura do ReservaModal.
  onReservarNovamente?: (reserva: ReservaDetalhe) => void;
}

type GravidadeOcorrencia = "baixa" | "media" | "alta";

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
  onReservarNovamente,
}: ReservaDetalheModalProps) {
  const [executando, setExecutando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [mostrarFormRejeicao, setMostrarFormRejeicao] = useState(false);
  const [motivoRejeicao, setMotivoRejeicao] = useState("");
  // Inicializado com o que a lista/detalhe já tinha carregado; atualizado ao vivo pelo
  // ChecklistFillModal (onAtualizado) sem precisar fechar este modal nem refazer a busca
  // da reserva inteira — ver ChecklistFillModal.tsx.
  const [checklistResumo, setChecklistResumo] = useState<ChecklistResumo>({
    finalizadoEm: reserva.checklistFinalizadoEm,
    todosConformes: reserva.checklistTodosConformes,
    totalItens: 0,
    totalRespondidos: 0,
  });
  const [checklistModalAberto, setChecklistModalAberto] = useState(false);
  // RF-RES-16/UC-04: ao concluir o uso, pergunta se houve ocorrência/avaria antes de
  // finalizar — "perguntando" não bloqueia estruturalmente a conclusão em duas chamadas
  // (POST /ocorrencia, depois PATCH /status concluir), mas garante que a ocorrência fique
  // registrada como parte do mesmo fluxo de conclusão.
  const [etapaConcluir, setEtapaConcluir] = useState<"nenhuma" | "perguntar" | "formOcorrencia">("nenhuma");
  const [ocorrenciaDescricao, setOcorrenciaDescricao] = useState("");
  const [ocorrenciaGravidade, setOcorrenciaGravidade] = useState<GravidadeOcorrencia>("baixa");
  const [ocorrenciaGeraManutencao, setOcorrenciaGeraManutencao] = useState(false);

  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "reserva-detalhe");

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
  // RF-CHK-06/RN-CHK-03: o checklist agora é portão da APROVAÇÃO, não mais do início de
  // uso — "pronto" cobre tanto "não exige checklist" quanto "exige e já foi finalizado
  // sem não conformidade". O backend revalida sempre; isto só decide se o botão Aprovar
  // fica habilitado, com o motivo explicado ao usuário em vez de um 409 sem contexto.
  const checklistPronto =
    !reserva.requerChecklist || (checklistResumo.finalizadoEm !== null && checklistResumo.todosConformes === true);
  const aprovarBloqueadoPeloChecklist = podeAprovarRejeitar && reserva.requerChecklist && !checklistPronto;
  const podeIniciarUso = ehAprovador && noEscopo && reserva.status === "agendada" && checklistPronto;
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

  function iniciarFluxoConcluir() {
    setEtapaConcluir("perguntar");
  }

  function concluirSemOcorrencia() {
    setEtapaConcluir("nenhuma");
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "concluir" }),
      })
    );
  }

  function confirmarOcorrenciaEConcluir() {
    if (ocorrenciaDescricao.trim().length < 5) {
      setErro("Descreva a ocorrência com pelo menos 5 caracteres.");
      return;
    }
    return executarAcao(async () => {
      await apiFetch(`/api/v1/reservas/${reserva.id}/ocorrencia`, {
        method: "POST",
        body: JSON.stringify({
          descricao: ocorrenciaDescricao.trim(),
          gravidade: ocorrenciaGravidade,
          geraManutencao: ocorrenciaGeraManutencao,
        }),
      });
      await apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "concluir" }),
      });
      setEtapaConcluir("nenhuma");
    });
  }

  function reservarNovamente() {
    onReservarNovamente?.(reserva);
    onClose();
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
    <div className={styles.modalOverlay} onClick={aoClicarNoOverlay}>
      <div className={styles.modal} ref={refDialogo} {...propsDialogo}>
        <div className={styles.modalHeader}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <h3 id={idTitulo} style={{ margin: 0 }}>
                {reserva.plataformaNome}
              </h3>
              <ReservaStatusBadge status={reserva.status} />
            </div>
            <span style={{ fontSize: "var(--text-meta)", color: "var(--ink-muted)" }}>
              {reserva.setorNome} · {formatarData(reserva.data)} · {reserva.horaInicio}–{reserva.horaFim}
            </span>
          </div>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Fechar detalhe da reserva">
            ✕
          </button>
        </div>
        <div className={styles.modalBody}>
          {erro && (
            <div className={styles.error} role="alert">
              {erro}
            </div>
          )}

          {reserva.status === "rejeitada" || reserva.status === "cancelada" ? (
            <div className={`${local.terminalBanner} ${local[reserva.status]}`}>
              <ReservaStatusBadge status={reserva.status} />
              {reserva.status === "rejeitada" && reserva.motivoRejeicao
                ? reserva.motivoRejeicao
                : "Esta reserva não segue mais o fluxo normal de aprovação/uso."}
            </div>
          ) : (
            <div className={local.stepper}>
              {(() => {
                const etapas = montarEtapas(reserva.requerChecklist);
                const chaveAtiva = chaveEtapaAtiva(reserva.status, reserva.requerChecklist, checklistPronto);
                const indiceAtual = etapas.findIndex((e) => e.chave === chaveAtiva);
                return etapas.map((etapa, i) => {
                  // A última etapa ("Concluída") é um estado final, não "em andamento" — ao
                  // chegar nela, ela também aparece como concluída (✓), não numerada.
                  const ultimaEtapa = i === etapas.length - 1;
                  const estado =
                    i < indiceAtual || (i === indiceAtual && ultimaEtapa) ? "done" : i === indiceAtual ? "active" : "";
                  return (
                    <div key={etapa.chave} style={{ display: "contents" }}>
                      {i > 0 && <div className={`${local.stepperConnector} ${i <= indiceAtual ? local.done : ""}`} />}
                      <div className={`${local.stepperStep} ${local[estado] ?? ""}`}>
                        <div className={local.stepperDot}>{estado === "done" ? <IconChecagem /> : i + 1}</div>
                        <span className={local.stepperLabel}>{etapa.label}</span>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}

          <div className={local.summaryCard}>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconPlataforma />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Plataforma</span>
                <span className={local.summaryValue}>{reserva.plataformaNome}</span>
              </div>
            </div>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconBandeira />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Prioridade</span>
                <PriorityBadge prioridade={reserva.prioridade} />
              </div>
            </div>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconCalendario />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Data</span>
                <span className={local.summaryValue}>{formatarData(reserva.data)}</span>
              </div>
            </div>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconRelogio />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Horário</span>
                <span className={local.summaryValue}>{reserva.horaInicio} – {reserva.horaFim}</span>
                {(reserva.horaInicioReal || reserva.horaFimReal) && (
                  <span className={local.summarySub}>
                    Real: {reserva.horaInicioReal ?? "—"} – {reserva.horaFimReal ?? "—"}
                  </span>
                )}
              </div>
            </div>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconPessoa />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Setor</span>
                <span className={local.summaryValue}>{reserva.setorNome}</span>
              </div>
            </div>
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconPessoa />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Responsável</span>
                <span className={local.summaryValue}>{reserva.solicitanteNome}</span>
              </div>
            </div>
            {reserva.aprovadoPorNome && (
              <div className={`${local.summaryRow} ${local.summaryRowFull}`}>
                <div className={local.summaryIcon}>
                  <IconChecagem />
                </div>
                <div className={local.summaryText}>
                  <span className={local.summaryLabel}>
                    {reserva.status === "pendente" ? "1ª aprovação (Gestor)" : "Aprovado por"}
                  </span>
                  <span className={local.summaryValue}>{reserva.aprovadoPorNome}</span>
                  {reserva.segundaAprovacaoPorNome && (
                    <span className={local.summarySub}>2ª aprovação (Admin): {reserva.segundaAprovacaoPorNome}</span>
                  )}
                  {reserva.status === "pendente" && !reserva.segundaAprovacaoPorNome && (
                    <span className={local.summarySub}>
                      Aguardando a segunda aprovação do Admin (RN-RES-08 — prioridade urgente ou plataforma de risco alto).
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <p className={local.motivoBlock}>{reserva.motivo}</p>

          {reserva.requerChecklist && (
            <div className={local.checklistCard}>
              <div className={local.checklistCardHeader}>
                <span className={local.checklistCardTitle}>Checklist de Segurança</span>
                <span
                  className={`${local.checklistBadge} ${
                    checklistResumo.finalizadoEm
                      ? checklistResumo.todosConformes
                        ? local.checklistBadgeOk
                        : local.checklistBadgeBloqueado
                      : local.checklistBadgePendente
                  }`}
                >
                  {checklistResumo.finalizadoEm ? (checklistResumo.todosConformes ? "Concluído" : "Não conforme") : "Pendente"}
                </span>
              </div>
              {checklistResumo.finalizadoEm && (
                <p className={local.checklistCardMeta}>
                  Finalizado em {new Date(checklistResumo.finalizadoEm).toLocaleString("pt-BR")}
                  {checklistResumo.todosConformes === false &&
                    " — revise a plataforma antes de aprovar esta reserva (RN-CHK-02)."}
                </p>
              )}
              <button type="button" className={styles.btnGhost} onClick={() => setChecklistModalAberto(true)}>
                {checklistResumo.finalizadoEm ? "Ver checklist" : "Preencher checklist"}
              </button>
            </div>
          )}
          {aprovarBloqueadoPeloChecklist && !mostrarFormRejeicao && (
            <p style={{ color: "var(--red)", fontSize: "var(--text-secondary)", marginTop: 8 }}>
              O botão &quot;Aprovar&quot; fica bloqueado até o checklist de segurança acima ser finalizado sem
              itens obrigatórios não conformes (RN-CHK-03).
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

          {etapaConcluir === "perguntar" && (
            <div className={styles.formGroup} style={{ marginTop: 14, gap: 10 }}>
              <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
                Houve alguma ocorrência ou avaria durante o uso? (RF-RES-16)
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className={styles.btnGhost} disabled={executando} onClick={concluirSemOcorrencia}>
                  Não, concluir normalmente
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={executando}
                  onClick={() => setEtapaConcluir("formOcorrencia")}
                >
                  Sim, reportar ocorrência
                </button>
              </div>
            </div>
          )}

          {etapaConcluir === "formOcorrencia" && (
            <div className={styles.formGrid} style={{ marginTop: 14 }}>
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <label htmlFor="ocorrencia-descricao">Descrição da ocorrência *</label>
                <textarea
                  id="ocorrencia-descricao"
                  rows={2}
                  value={ocorrenciaDescricao}
                  onChange={(e) => setOcorrenciaDescricao(e.target.value)}
                  placeholder="Descreva a avaria ou ocorrência..."
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="ocorrencia-gravidade">Gravidade</label>
                <select
                  id="ocorrencia-gravidade"
                  value={ocorrenciaGravidade}
                  onChange={(e) => setOcorrenciaGravidade(e.target.value as GravidadeOcorrencia)}
                >
                  <option value="baixa">Baixa</option>
                  <option value="media">Média</option>
                  <option value="alta">Alta</option>
                </select>
              </div>
              <div className={styles.formGroup} style={{ justifyContent: "flex-end" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none" }}>
                  <input
                    type="checkbox"
                    checked={ocorrenciaGeraManutencao}
                    onChange={(e) => setOcorrenciaGeraManutencao(e.target.checked)}
                  />
                  Abrir manutenção automática (RN-PLAT-04 — bloqueia novas reservas na plataforma)
                </label>
              </div>
              <div className={`${styles.formGroupFull}`} style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className={styles.btnGhost} disabled={executando} onClick={() => setEtapaConcluir("perguntar")}>
                  Voltar
                </button>
                <button type="button" className={styles.btnPrimary} disabled={executando} onClick={confirmarOcorrenciaEConcluir}>
                  Registrar Ocorrência e Concluir
                </button>
              </div>
            </div>
          )}

          {noEscopo && <AnexosComentarios reservaId={reserva.id} />}
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
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={executando || aprovarBloqueadoPeloChecklist}
                title={aprovarBloqueadoPeloChecklist ? "Finalize o checklist de segurança antes de aprovar." : undefined}
                onClick={aprovar}
              >
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
          {podeConcluir && etapaConcluir === "nenhuma" && (
            <button type="button" className={styles.btnPrimary} disabled={executando} onClick={iniciarFluxoConcluir}>
              Concluir
            </button>
          )}
          {noEscopo && ["concluida", "cancelada"].includes(reserva.status) && onReservarNovamente && (
            <button type="button" className={styles.btnPrimary} disabled={executando} onClick={reservarNovamente}>
              Reservar Novamente
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

      {checklistModalAberto && (
        <ChecklistFillModal
          reservaId={reserva.id}
          plataformaNome={reserva.plataformaNome}
          somenteLeitura={checklistSomenteLeitura}
          onClose={() => setChecklistModalAberto(false)}
          onAtualizado={setChecklistResumo}
        />
      )}
    </div>
  );
}
