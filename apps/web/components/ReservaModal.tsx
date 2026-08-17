"use client";

import { useEffect, useState, type FormEvent } from "react";
import { combinarDataHoraBrasilia, validarAntecedenciaMinima } from "@plataformares/shared";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";

export interface ReservaFormValues {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  quantidadePessoas: number;
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
  // null = capacidade ainda não cadastrada para esta plataforma (não confundir com 0).
  capacidade: number | null;
}

// RN-RES-03: mesma regra do backend (validarJanelaReserva, apps/api) — usada aqui só
// para feedback imediato no formulário. O backend permanece a fonte definitiva: mesmo
// que este valor fique desatualizado em relação a uma mudança recente na configuração
// do sistema, a criação da reserva é sempre revalidada no servidor.
const ANTECEDENCIA_MINIMA_MINUTOS_PADRAO = 120;

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
  // Preenchidos ao criar a partir de um clique num horário vazio do Calendário — nunca
  // presentes no fluxo "Reservar novamente" (RF-RES-13), que deliberadamente não herda data/hora.
  data?: string;
  horaInicio?: string;
  horaFim?: string;
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
  const [data, setData] = useState(valoresIniciais?.data ?? hojeStr());
  const [horaInicio, setHoraInicio] = useState(valoresIniciais?.horaInicio ?? "");
  const [horaFim, setHoraFim] = useState(valoresIniciais?.horaFim ?? "");
  // String (não number) para o campo poder ficar vazio enquanto o usuário apaga e
  // redigita, sem o React forçar de volta para "1" a cada tecla.
  const [quantidadePessoas, setQuantidadePessoas] = useState("1");
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

  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "reserva-modal");

  useEffect(() => {
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((lista) =>
        // Além de inativas, plataformas em manutenção também não podem ser reservadas
        // (RN-PLAT-04, desde S11): elas apareciam no seletor e o usuário só descobria a
        // recusa depois de preencher o formulário inteiro e receber 409 do backend.
        setPlataformas(lista.filter((p) => p.status !== "inativa" && p.status !== "manutencao"))
      )
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

  // RF/RN de capacidade: a plataforma selecionada informa o teto oficial (vindo do
  // backend em /api/v1/plataformas) — nunca um valor calculado/hardcoded aqui.
  const plataformaSelecionada = plataformas.find((p) => p.id === plataformaId) ?? null;
  const capacidade = plataformaSelecionada?.capacidade ?? null;

  const quantidadeNum = Number(quantidadePessoas);
  const quantidadePreenchida = quantidadePessoas.trim() !== "";
  const quantidadeValida = quantidadePreenchida && Number.isInteger(quantidadeNum) && quantidadeNum >= 1;
  const excedeCapacidade = quantidadeValida && capacidade !== null && quantidadeNum > capacidade;
  const erroQuantidade = !quantidadePreenchida
    ? "Informe a quantidade de pessoas."
    : !quantidadeValida
      ? "Quantidade de pessoas deve ser um número inteiro de pelo menos 1."
      : excedeCapacidade
        ? `Esta plataforma comporta no máximo ${capacidade} pessoa(s).`
        : null;

  // RN-RES-03: mesmo cálculo do backend (packages/shared/datetime.ts), só para feedback
  // imediato — recalculado a cada render, então acompanha o relógio enquanto o modal
  // fica aberto.
  const erroAntecedencia =
    data && horaInicio
      ? (() => {
          const resultado = validarAntecedenciaMinima(
            combinarDataHoraBrasilia(data, horaInicio),
            new Date(),
            ANTECEDENCIA_MINIMA_MINUTOS_PADRAO
          );
          return resultado.ok ? null : "Selecione um horário com pelo menos 2 horas de antecedência.";
        })()
      : null;

  const bloqueado =
    horarioInvalido || conflitoMotivo !== null || !!erroAntecedencia || !quantidadeValida || excedeCapacidade;

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
    if (erroAntecedencia) {
      setErro(erroAntecedencia);
      return;
    }
    if (erroQuantidade) {
      setErro(erroQuantidade);
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
        quantidadePessoas: quantidadeNum,
        motivo: motivo.trim(),
        prioridade,
        recorrencia: repetirSemanalmente ? { quantidadeOcorrencias } : undefined,
        setorId: exigeSelecaoDeSetor ? setorSelecionadoId : undefined,
      });
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao criar reserva."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={aoClicarNoOverlay}>
      <div className={styles.modal} ref={refDialogo} {...propsDialogo}>
        <div className={styles.modalHeader}>
          {/* "Reservar novamente" sempre chega com plataformaId pré-preenchido; a criação
              rápida a partir de um clique no Calendário só preenche data/horário, com
              plataforma em branco — por isso o título distingue pelos dois primeiros,
              não pela mera presença de valoresIniciais. */}
          <h3 id={idTitulo}>{valoresIniciais?.plataformaId ? "Reservar Novamente" : "Nova Reserva"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && (
              <div className={styles.error} role="alert">
                {erro}
              </div>
            )}
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
                  aria-invalid={erroAntecedencia ? true : undefined}
                  aria-describedby={erroAntecedencia ? "rf-start-erro" : undefined}
                  required
                />
                {erroAntecedencia && (
                  <span id="rf-start-erro" className={styles.fieldError} role="alert">
                    {erroAntecedencia}
                  </span>
                )}
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-end">Horário Final *</label>
                <input
                  id="rf-end"
                  type="time"
                  value={horaFim}
                  onChange={(e) => setHoraFim(e.target.value)}
                  aria-invalid={horarioInvalido ? true : undefined}
                  aria-describedby={horarioInvalido ? "rf-end-erro" : undefined}
                  required
                />
                {horarioInvalido && (
                  <span id="rf-end-erro" className={styles.fieldError} role="alert">
                    O horário final deve ser após o horário inicial.
                  </span>
                )}
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="rf-quantidade">Quantidade de Pessoas *</label>
                <input
                  id="rf-quantidade"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={quantidadePessoas}
                  onChange={(e) => setQuantidadePessoas(e.target.value)}
                  aria-invalid={erroQuantidade ? true : undefined}
                  aria-describedby={erroQuantidade ? "rf-quantidade-erro" : undefined}
                  required
                />
                {erroQuantidade && (
                  <span id="rf-quantidade-erro" className={styles.fieldError} role="alert">
                    {erroQuantidade}
                  </span>
                )}
              </div>
              <div className={styles.formGroup}>
                <label>Capacidade da Plataforma</label>
                <p className={styles.capacidadeInfo}>
                  {!plataformaSelecionada
                    ? "Selecione uma plataforma para ver a capacidade."
                    : capacidade === null
                      ? "Capacidade não cadastrada"
                      : `Capacidade máxima: ${capacidade} pessoa(s)`}
                </p>
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
                    <label htmlFor="rf-ocorrencias" style={{ fontSize: "var(--text-secondary)" }}>
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

            {/* aria-live: o alerta de conflito aparece sozinho, depois do debounce, sem
                nenhuma ação do usuário — sem isto, quem usa leitor de tela só descobria o
                bloqueio ao tentar enviar e ver o botão desabilitado. */}
            <div aria-live="polite">
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
              {repetirSemanalmente && !bloqueado && (
                <p className={styles.hint}>
                  A checagem de conflito acima vale para a primeira data. As {quantidadeOcorrencias} ocorrências são
                  criadas em bloco: se qualquer uma delas colidir, nenhuma é criada.
                </p>
              )}
            </div>
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
