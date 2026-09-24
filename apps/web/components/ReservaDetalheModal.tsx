"use client";

import { useEffect, useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import local from "./ReservaDetalheModal.module.css";
import { apiFetch, ApiRequestError } from "../lib/api";
import { Building2, Phone, PhoneCall } from "lucide-react";
import {
  CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO,
  CODIGO_CONFLITO_SUBSTITUIVEL,
  formatarTelefone,
  telefoneParaLink,
  type ConflitoAprovacao,
} from "@plataformares/shared";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { ComentariosReserva } from "./ComentariosReserva";

// Passo a passo do caminho feliz — cancelada/rejeitada são estados terminais à parte
// (ver terminalBanner) e não aparecem aqui, pois quebram a progressão linear.
//
/* Fluxo com aprovação (migration 0022): solicitação de colaborador passa por "Aprovação";
   reserva criada por Admin/Gestor já nasce agendada (a etapa aparece concluída). Cancelada
   e rejeitada não percorrem a régua: caem no banner terminal. */
type EtapaChave = "pendente" | "agendada" | "em_uso" | "concluida";

const ETAPAS: Array<{ chave: EtapaChave; label: string }> = [
  { chave: "pendente", label: "Aprovação" },
  { chave: "agendada", label: "Agendada" },
  { chave: "em_uso", label: "Em uso" },
  { chave: "concluida", label: "Concluída" },
];

function chaveEtapaAtiva(status: string): EtapaChave {
  if (status === "em_uso") return "em_uso";
  if (status === "concluida") return "concluida";
  if (status === "pendente") return "pendente";
  return "agendada";
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
  /* Empresa informada quando o setor é "Terceirizados" (ver empresaTerceirizada.ts em
     shared). Null em setores internos e em reservas anteriores à migration 0020 — o modal
     só mostra a linha quando há valor, para não poluir o detalhe com "—" em toda reserva. */
  empresaTerceirizada: string | null;
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
  telefoneContato: string | null;
  plataformaTelefoneEmergencia: string | null;
  aprovadoPorNome: string | null;
  segundaAprovacaoPorNome: string | null;
  motivoRejeicao: string | null;
  horaInicioReal: string | null;
  horaFimReal: string | null;
  // Substituição por urgência (migration 0022): cancelada com vínculo para a urgente.
  substituidaPorId?: string | null;
  motivoCancelamento?: string | null;
  usoContabilizadoMinutos?: number | null;
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
  // Decisão de aprovação. `substituicao` guarda os conflitos devolvidos pelo backend quando a
  // urgente colide com reserva existente — a substituição só acontece depois de o aprovador
  // ver esses dados e confirmar aqui (nunca implicitamente, nunca com alert()).
  const [rejeitando, setRejeitando] = useState(false);
  const [motivoRejeicaoTexto, setMotivoRejeicaoTexto] = useState("");
  const [substituicao, setSubstituicao] = useState<{
    conflitos: ConflitoAprovacao[];
    emUso: boolean;
    mensagem: string;
  } | null>(null);
  const [confirmaInterrupcao, setConfirmaInterrupcao] = useState(false);
  // Conflito que impede a aprovação e NÃO admite substituição (reserva normal sobre horário
  // confirmado, urgente sobre urgente, bloqueio de agenda) — informado já ao abrir.
  const [avisoAnalise, setAvisoAnalise] = useState<string | null>(null);

  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(
    onClose,
    "reserva-detalhe"
  );

  // Admin não tem restrição de escopo; Gestor de Setor só age em reservas do próprio setor.
  const noEscopo = perfil === "admin" || reserva.setorId === setorId;
  const ehAprovador = perfil === "admin" || perfil === "gestor_setor";
  /* Iniciar/concluir são FALLBACK administrativo: no fluxo normal quem move a reserva é o
     sincronizador por horário no servidor. Ficam disponíveis para exceções operacionais
     (equipamento liberado antes, uso encerrado adiantado) e por isso são ações
     secundárias, não os botões dominantes do modal. */
  const podeIniciarUso = ehAprovador && noEscopo && reserva.status === "agendada";
  const podeConcluir = ehAprovador && noEscopo && reserva.status === "em_uso";
  const podeCancelar = ["pendente", "agendada", "em_uso"].includes(reserva.status) && noEscopo;
  // Aprovar/rejeitar/substituir: Admin e Gestor de QUALQUER setor (aprovadores globais). O
  // backend aplica a mesma regra — esconder aqui é só para não oferecer um botão que daria 403.
  const podeDecidir = ehAprovador && reserva.status === "pendente";

  // Pré-análise ao abrir: se a solicitação (tipicamente urgente) conflita com uma reserva
  // confirmada, o aprovador vê o conflito e a decisão antes de clicar em qualquer coisa. A
  // decisão em si (POST /aprovar) revalida tudo de novo no servidor.
  useEffect(() => {
    if (!podeDecidir) return;
    let cancelado = false;
    apiFetch<{
      conflitos: ConflitoAprovacao[];
      bloqueio: { motivo: string } | null;
      emUso: boolean;
      podeSubstituir: boolean;
    }>(`/api/v1/reservas/${reserva.id}/analise-aprovacao`)
      .then((analise) => {
        if (cancelado) return;
        if (analise.podeSubstituir) {
          setSubstituicao({
            conflitos: analise.conflitos,
            emUso: analise.emUso,
            mensagem:
              "Esta solicitação urgente conflita com uma reserva existente. Mantenha a reserva atual ou substitua-a e aprove a urgente.",
          });
        } else if (analise.bloqueio) {
          setAvisoAnalise(`O horário está bloqueado na agenda (${analise.bloqueio.motivo}). Bloqueio não pode ser substituído.`);
        } else if (analise.conflitos.length > 0) {
          const c = analise.conflitos[0];
          setAvisoAnalise(
            reserva.prioridade === "urgente"
              ? `O horário já está ocupado por outra reserva urgente (${c.setorNome}, ${c.horaInicio}–${c.horaFim}). Urgência não substitui urgência.`
              : `O horário já foi confirmado para ${c.setorNome} (${c.horaInicio}–${c.horaFim}). Esta solicitação não pode ser aprovada.`
          );
        }
      })
      .catch(() => undefined); // a pré-análise é só conveniência; a aprovação revalida
    return () => {
      cancelado = true;
    };
  }, [podeDecidir, reserva.id, reserva.prioridade]);
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

  function iniciarUso() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "iniciar_uso" }),
      })
    );
  }

  /* Concluir passou a ser uma ação direta. O antigo fluxo perguntava "houve ocorrência?"
     e abria um formulário separado — mecanismo que agora está consolidado na timeline de
     comentários (marcar um comentário como não conformidade). Duas portas para registrar
     a mesma coisa deixariam o histórico dividido entre dois lugares. */
  function concluir() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ acao: "concluir" }),
      })
    );
  }

  async function aprovar(opcoes: { substituirConflitantes?: boolean; confirmarInterrupcaoEmUso?: boolean } = {}) {
    setErro(null);
    setExecutando(true);
    try {
      await apiFetch(`/api/v1/reservas/${reserva.id}/aprovar`, { method: "POST", body: JSON.stringify(opcoes) });
      setSubstituicao(null);
      await onAtualizado();
    } catch (err) {
      const codigo = err instanceof ApiRequestError ? err.codigo : undefined;
      if (
        err instanceof ApiRequestError &&
        (codigo === CODIGO_CONFLITO_SUBSTITUIVEL || codigo === CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO)
      ) {
        const corpo = err.corpo ?? {};
        setSubstituicao({
          conflitos: (corpo.conflitos as ConflitoAprovacao[] | undefined) ?? [],
          emUso: Boolean(corpo.emUso) || codigo === CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO,
          mensagem: err.message,
        });
        setConfirmaInterrupcao(false);
      } else {
        setErro(err instanceof Error ? err.message : "Não foi possível aprovar a reserva.");
      }
    } finally {
      setExecutando(false);
    }
  }

  function confirmarSubstituicao() {
    if (!substituicao) return;
    return aprovar({
      substituirConflitantes: true,
      confirmarInterrupcaoEmUso: substituicao.emUso && confirmaInterrupcao,
    });
  }

  function rejeitar() {
    return executarAcao(() =>
      apiFetch(`/api/v1/reservas/${reserva.id}/rejeitar`, {
        method: "POST",
        body: JSON.stringify({ motivo: motivoRejeicaoTexto.trim() }),
      })
    );
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
                : reserva.status === "cancelada" && reserva.motivoCancelamento
                  ? reserva.motivoCancelamento
                  : "Esta reserva não segue mais o fluxo normal de uso."}
            </div>
          ) : (
            <div className={local.stepper}>
              {(() => {
                const etapas = ETAPAS;
                const chaveAtiva = chaveEtapaAtiva(reserva.status);
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

          {podeDecidir && avisoAnalise && !substituicao && (
            <p className={local.avisoPendente} role="status">
              {avisoAnalise}
            </p>
          )}

          {reserva.status === "pendente" && !podeDecidir && (
            <p className={local.avisoPendente}>Solicitação aguardando aprovação de um Admin ou Gestor do setor.</p>
          )}

          {podeDecidir && substituicao && (
            <section className={local.decisao} aria-labelledby="decisao-titulo">
              <h4 id="decisao-titulo" className={local.decisaoTitulo}>
                Atenção: conflito com reserva existente
              </h4>
              <p className={local.decisaoTexto}>{substituicao.mensagem}</p>
              <div className={local.decisaoBloco}>
                <span className={local.decisaoRotulo}>
                  {substituicao.conflitos.length === 1 ? "Reserva atual" : "Reservas atuais"}
                </span>
                {substituicao.conflitos.map((c) => (
                  <dl key={c.id} className={local.decisaoLinha}>
                    <div>
                      <dt>Plataforma</dt>
                      <dd>{c.plataformaNome}</dd>
                    </div>
                    <div>
                      <dt>Horário</dt>
                      <dd>
                        {c.horaInicio}–{c.horaFim}
                      </dd>
                    </div>
                    <div>
                      <dt>Responsável</dt>
                      <dd>{c.solicitanteNome}</dd>
                    </div>
                    <div>
                      <dt>Setor</dt>
                      <dd>{c.setorNome}</dd>
                    </div>
                    <div>
                      <dt>Prioridade</dt>
                      <dd>
                        <PriorityBadge prioridade={c.prioridade} />
                      </dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <ReservaStatusBadge status={c.status} />
                      </dd>
                    </div>
                  </dl>
                ))}
              </div>
              <div className={local.decisaoBloco}>
                <span className={local.decisaoRotulo}>Nova solicitação</span>
                <dl className={local.decisaoLinha}>
                  <div>
                    <dt>Responsável</dt>
                    <dd>{reserva.solicitanteNome}</dd>
                  </div>
                  <div>
                    <dt>Setor</dt>
                    <dd>{reserva.setorNome}</dd>
                  </div>
                  <div>
                    <dt>Horário</dt>
                    <dd>
                      {reserva.horaInicio}–{reserva.horaFim}
                    </dd>
                  </div>
                  <div>
                    <dt>Prioridade</dt>
                    <dd>
                      <PriorityBadge prioridade={reserva.prioridade} />
                    </dd>
                  </div>
                </dl>
              </div>
              {substituicao.emUso && (
                <label className={local.decisaoEmUso}>
                  <input
                    type="checkbox"
                    checked={confirmaInterrupcao}
                    onChange={(e) => setConfirmaInterrupcao(e.target.checked)}
                  />
                  Esta plataforma está atualmente em uso. Confirmo que a substituição encerrará a reserva atual.
                </label>
              )}
              <p className={local.decisaoNota}>
                A reserva substituída não é apagada: fica cancelada, com o motivo e o vínculo para esta reserva
                urgente.
              </p>
            </section>
          )}

          {podeDecidir && rejeitando && !substituicao && (
            <section className={local.decisao} aria-labelledby="rejeicao-titulo">
              <h4 id="rejeicao-titulo" className={local.decisaoTitulo}>
                Rejeitar solicitação
              </h4>
              <label htmlFor="rd-motivo-rejeicao" className={local.decisaoRotulo}>
                Motivo (visível ao solicitante)
              </label>
              <textarea
                id="rd-motivo-rejeicao"
                className={local.decisaoTextarea}
                rows={2}
                maxLength={500}
                value={motivoRejeicaoTexto}
                onChange={(e) => setMotivoRejeicaoTexto(e.target.value)}
                autoFocus
              />
            </section>
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
            {/* Vem logo após o Setor porque é o que identifica QUEM é o solicitante quando
                o setor é "Terceirizados" (a pessoa é da empresa, não da casa). Só renderiza
                com valor: reservas antigas e de setores internos não têm o dado, e uma linha
                "—" em toda reserva seria ruído. */}
            {reserva.empresaTerceirizada && (
              <div className={local.summaryRow} data-campo="empresa-terceirizada">
                <div className={local.summaryIcon}>
                  <Building2 size={14} strokeWidth={1.75} />
                </div>
                <div className={local.summaryText}>
                  <span className={local.summaryLabel}>Empresa terceirizada</span>
                  <span className={local.summaryValue}>{reserva.empresaTerceirizada}</span>
                </div>
              </div>
            )}
            <div className={local.summaryRow}>
              <div className={local.summaryIcon}>
                <IconPessoa />
              </div>
              <div className={local.summaryText}>
                <span className={local.summaryLabel}>Responsável</span>
                <span className={local.summaryValue}>{reserva.solicitanteNome}</span>
              </div>
            </div>
            {/* Dois telefones, rotulados de forma inequívoca: "quem é o responsável por
                esta reserva agora" e "para onde ligar se o equipamento der problema". Se
                fossem só "Telefone" e "Telefone 2", alguém acabaria discando o errado no
                pior momento. Ambos viram link tel: — em campo, o acesso é pelo celular. */}
            {reserva.telefoneContato && (
              <div className={local.summaryRow}>
                <div className={local.summaryIcon}>
                  <Phone size={14} strokeWidth={1.75} />
                </div>
                <div className={local.summaryText}>
                  <span className={local.summaryLabel}>Contato do responsável</span>
                  <a className={local.summaryValue} href={`tel:${telefoneParaLink(reserva.telefoneContato)}`}>
                    {formatarTelefone(reserva.telefoneContato)}
                  </a>
                </div>
              </div>
            )}
            {reserva.plataformaTelefoneEmergencia && (
              <div className={local.summaryRow}>
                <div className={local.summaryIcon}>
                  <PhoneCall size={14} strokeWidth={1.75} />
                </div>
                <div className={local.summaryText}>
                  <span className={local.summaryLabel}>Emergência da plataforma</span>
                  <a
                    className={local.summaryValue}
                    href={`tel:${telefoneParaLink(reserva.plataformaTelefoneEmergencia)}`}
                  >
                    {formatarTelefone(reserva.plataformaTelefoneEmergencia)}
                  </a>
                </div>
              </div>
            )}

            {reserva.aprovadoPorNome && (
              <div className={`${local.summaryRow} ${local.summaryRowFull}`}>
                <div className={local.summaryIcon}>
                  <IconChecagem />
                </div>
                <div className={local.summaryText}>
                  <span className={local.summaryLabel}>Aprovada por</span>
                  <span className={local.summaryValue}>{reserva.aprovadoPorNome}</span>
                  {reserva.segundaAprovacaoPorNome && (
                    <span className={local.summarySub}>2ª aprovação: {reserva.segundaAprovacaoPorNome}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          <p className={local.motivoBlock}>{reserva.motivo}</p>

          {/* Seção única de comentários — substituiu as abas "Anexos | Comentários". É
              também onde se registra não conformidade, consolidando o antigo formulário
              de ocorrência que ficava no fluxo de conclusão. Ler e comentar são abertos a
              qualquer usuário autenticado (conteúdo operacional compartilhado, não pessoal);
              só editar/excluir um comentário já existente continua restrito a quem o
              escreveu (ou admin) — regra aplicada pelo próprio backend em PATCH/DELETE
              (podeEditar/podeExcluir de cada entrada), não aqui. */}
          <ComentariosReserva reservaId={reserva.id} />
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            Fechar
          </button>
          {/* Decisão de aprovação: ações dominantes do modal enquanto a reserva está pendente. */}
          {podeDecidir && substituicao && (
            <>
              <button
                type="button"
                className={styles.btnGhost}
                disabled={executando}
                onClick={() => setSubstituicao(null)}
              >
                Manter reserva atual
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                disabled={executando || (substituicao.emUso && !confirmaInterrupcao)}
                onClick={confirmarSubstituicao}
              >
                Substituir e aprovar urgente
              </button>
            </>
          )}
          {podeDecidir && rejeitando && !substituicao && (
            <>
              <button type="button" className={styles.btnGhost} disabled={executando} onClick={() => setRejeitando(false)}>
                Voltar
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                disabled={executando || motivoRejeicaoTexto.trim().length < 3}
                onClick={rejeitar}
              >
                Confirmar rejeição
              </button>
            </>
          )}
          {podeDecidir && !rejeitando && !substituicao && (
            <>
              <button type="button" className={styles.btnGhost} disabled={executando} onClick={() => setRejeitando(true)}>
                Rejeitar
              </button>
              <button type="button" className={styles.btnPrimary} disabled={executando} onClick={() => aprovar()}>
                Aprovar
              </button>
            </>
          )}
          {/* Iniciar/concluir viraram ações SECUNDÁRIAS (btnGhost): no fluxo normal o
              sincronizador faz as duas por horário, e um botão preto sugerindo que alguém
              precisa clicar contradiria o comportamento real do sistema. */}
          {podeIniciarUso && (
            <button
              type="button"
              className={styles.btnGhost}
              disabled={executando}
              onClick={iniciarUso}
              title="A reserva inicia sozinha no horário agendado. Use apenas para antecipar."
            >
              Iniciar agora
            </button>
          )}
          {podeConcluir && (
            <button
              type="button"
              className={styles.btnGhost}
              disabled={executando}
              onClick={concluir}
              title="A reserva conclui sozinha no horário final. Use apenas para encerrar antes."
            >
              Concluir
            </button>
          )}
          {noEscopo && ["concluida", "cancelada"].includes(reserva.status) && onReservarNovamente && (
            <button type="button" className={styles.btnPrimary} disabled={executando} onClick={reservarNovamente}>
              Reservar Novamente
            </button>
          )}
          {podeCancelar && !podeDecidir && (
            <button type="button" className={styles.btnDanger} disabled={executando} onClick={cancelar}>
              Cancelar Reserva
            </button>
          )}
          {podeCancelarSerie && (
            <button type="button" className={styles.btnDanger} disabled={executando} onClick={cancelarSerie}>
              Cancelar Série
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
