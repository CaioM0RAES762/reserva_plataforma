"use client";

import { useEffect, useState } from "react";
import styles from "./ChecklistFillModal.module.css";
import pageStyles from "../app/(app)/reservas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";

type ResultadoItem = "conforme" | "nao_conforme" | "nao_aplicavel";

interface ChecklistItemApi {
  itemId: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  resultado: ResultadoItem | null;
  observacao: string | null;
  fotoUrl: string | null;
}

interface ChecklistReservaApi {
  requerChecklist: boolean;
  templateNome: string | null;
  finalizadoEm: string | null;
  todosConformes: boolean | null;
  preenchidoPorNome: string | null;
  preenchidoEm: string | null;
  totalItens: number;
  totalRespondidos: number;
  itens: ChecklistItemApi[];
}

interface RespostaLocal {
  resultado: ResultadoItem | null;
  observacao: string;
  fotoBase64: string | null;
  fotoUrl: string | null;
}

export interface ChecklistResumo {
  finalizadoEm: string | null;
  todosConformes: boolean | null;
  totalItens: number;
  totalRespondidos: number;
}

export interface ChecklistFillModalProps {
  reservaId: string;
  plataformaNome: string;
  somenteLeitura: boolean;
  onClose: () => void;
  // Disparado após salvar/finalizar com sucesso (ou ao carregar pela primeira vez), com o
  // resumo atualizado — o chamador decide o que fazer (recarregar uma lista, atualizar um
  // resumo exibido em outro modal sem precisar fechá-lo, etc.), sem precisar refazer a
  // própria consulta do checklist.
  onAtualizado?: (resumo: ChecklistResumo) => void;
}

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

// Correção do fluxo de Checklist — interface dedicada de preenchimento (RF-CHK-06):
// substitui o antigo bloco embutido no Detalhe da Reserva. Três resultados por item
// (conforme/não conforme/não aplicável, não mais um booleano), progresso salvo à parte da
// finalização (PUT = rascunho, aceita parcial; POST /finalizar = exige tudo respondido) e
// um contador "X de Y" — o checklist agora é portão da APROVAÇÃO, então quem preenche
// precisa entender claramente se já terminou ou não.
export function ChecklistFillModal({
  reservaId,
  plataformaNome,
  somenteLeitura,
  onClose,
  onAtualizado,
}: ChecklistFillModalProps) {
  const [carregando, setCarregando] = useState(true);
  const [dados, setDados] = useState<ChecklistReservaApi | null>(null);
  const [respostas, setRespostas] = useState<Record<string, RespostaLocal>>({});
  const [salvando, setSalvando] = useState<"progresso" | "finalizar" | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "checklist-fill");

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const resultado = await apiFetch<ChecklistReservaApi>(`/api/v1/reservas/${reservaId}/checklist`);
      setDados(resultado);
      const mapa: Record<string, RespostaLocal> = {};
      for (const item of resultado.itens) {
        mapa[item.itemId] = {
          resultado: item.resultado,
          observacao: item.observacao ?? "",
          fotoBase64: null,
          fotoUrl: item.fotoUrl,
        };
      }
      setRespostas(mapa);
      onAtualizado?.({
        finalizadoEm: resultado.finalizadoEm,
        todosConformes: resultado.todosConformes,
        totalItens: resultado.totalItens,
        totalRespondidos: resultado.totalRespondidos,
      });
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar checklist."));
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservaId]);

  function definirResultado(itemId: string, resultado: ResultadoItem) {
    setRespostas((atual) => ({ ...atual, [itemId]: { ...atual[itemId], resultado } }));
  }

  function definirObservacao(itemId: string, observacao: string) {
    setRespostas((atual) => ({ ...atual, [itemId]: { ...atual[itemId], observacao } }));
  }

  async function definirFoto(itemId: string, arquivo: File | null) {
    if (!arquivo) return;
    const base64 = await lerArquivoComoBase64(arquivo);
    setRespostas((atual) => ({ ...atual, [itemId]: { ...atual[itemId], fotoBase64: base64 } }));
  }

  function respostasParaEnvio() {
    if (!dados) return [];
    return dados.itens
      .filter((item) => respostas[item.itemId]?.resultado !== null)
      .map((item) => {
        const resposta = respostas[item.itemId];
        return {
          itemId: item.itemId,
          resultado: resposta.resultado as ResultadoItem,
          observacao: resposta.observacao.trim() || undefined,
          fotoBase64: resposta.fotoBase64 ?? undefined,
        };
      });
  }

  async function salvarProgresso() {
    setErro(null);
    const naoConformeSemObservacao = respostasParaEnvio().find(
      (r) => r.resultado === "nao_conforme" && !r.observacao
    );
    if (naoConformeSemObservacao) {
      setErro("Todo item não conforme exige uma observação preenchida.");
      return;
    }
    setSalvando("progresso");
    try {
      await apiFetch(`/api/v1/reservas/${reservaId}/checklist`, {
        method: "PUT",
        body: JSON.stringify({ respostas: respostasParaEnvio() }),
      });
      await carregar();
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao salvar o progresso do checklist."));
    } finally {
      setSalvando(null);
    }
  }

  async function finalizar() {
    if (!dados) return;
    setErro(null);
    const itensObrigatoriosSemResposta = dados.itens.filter(
      (item) => item.obrigatorio && respostas[item.itemId]?.resultado === null
    );
    if (itensObrigatoriosSemResposta.length > 0) {
      setErro("Responda todos os itens obrigatórios antes de finalizar.");
      return;
    }
    const naoConformeSemObservacao = respostasParaEnvio().find(
      (r) => r.resultado === "nao_conforme" && !r.observacao
    );
    if (naoConformeSemObservacao) {
      setErro("Todo item não conforme exige uma observação preenchida.");
      return;
    }
    setSalvando("finalizar");
    try {
      await apiFetch(`/api/v1/reservas/${reservaId}/checklist/finalizar`, {
        method: "POST",
        body: JSON.stringify({ respostas: respostasParaEnvio() }),
      });
      await carregar();
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao finalizar o checklist."));
    } finally {
      setSalvando(null);
    }
  }

  const totalRespondidos = dados ? dados.itens.filter((item) => respostas[item.itemId]?.resultado !== null).length : 0;
  const finalizado = Boolean(dados?.finalizadoEm);
  const podeFinalizar = !somenteLeitura && dados && totalRespondidos === dados.totalItens;

  return (
    <div className={pageStyles.modalOverlay} onClick={aoClicarNoOverlay}>
      <div className={pageStyles.modal} ref={refDialogo} {...propsDialogo}>
        <div className={pageStyles.modalHeader}>
          <div>
            <h3 id={idTitulo} style={{ margin: 0 }}>
              Checklist de Segurança
            </h3>
            <span style={{ fontSize: "var(--text-meta)", color: "var(--ink-muted)" }}>
              {plataformaNome}
              {dados?.templateNome ? ` · ${dados.templateNome}` : ""}
            </span>
          </div>
          <button type="button" className={pageStyles.modalClose} onClick={onClose} aria-label="Fechar checklist">
            ✕
          </button>
        </div>

        <div className={pageStyles.modalBody}>
          {carregando && <p className={styles.aviso}>Carregando…</p>}
          {erro && (
            <div className={pageStyles.error} role="alert">
              {erro}
            </div>
          )}

          {!carregando && dados && !dados.requerChecklist && (
            <p className={styles.aviso}>Esta plataforma não exige checklist de segurança.</p>
          )}

          {!carregando && dados && dados.requerChecklist && (
            <>
              <div className={styles.progressoBar}>
                <div className={styles.progressoHeader}>
                  <span>
                    {totalRespondidos} de {dados.totalItens} itens avaliados
                  </span>
                  <span className={`${styles.statusBadge} ${finalizado ? (dados.todosConformes ? styles.statusOk : styles.statusBloqueado) : styles.statusPendente}`}>
                    {finalizado ? (dados.todosConformes ? "Concluído — conforme" : "Concluído — não conforme") : "Em preenchimento"}
                  </span>
                </div>
                <div className={styles.progressoTrack}>
                  <div
                    className={styles.progressoFill}
                    style={{ width: dados.totalItens > 0 ? `${(totalRespondidos / dados.totalItens) * 100}%` : "0%" }}
                  />
                </div>
              </div>

              <div className={styles.itens}>
                {dados.itens.map((item, indice) => {
                  const resposta = respostas[item.itemId];
                  const mostrarObservacao = resposta?.resultado === "nao_conforme";
                  return (
                    <div key={item.itemId} className={styles.item}>
                      <div className={styles.itemHeader}>
                        <span className={styles.itemNumero}>{String(indice + 1).padStart(2, "0")}</span>
                        <span className={styles.itemDescricao}>
                          {item.descricao}
                          {item.obrigatorio && <span className={styles.itemObrigatorio}>*</span>}
                        </span>
                      </div>
                      <div className={styles.toggleGroup}>
                        <button
                          type="button"
                          disabled={somenteLeitura}
                          className={`${styles.toggleBtn} ${resposta?.resultado === "conforme" ? styles.toggleConformeAtivo : ""}`}
                          onClick={() => definirResultado(item.itemId, "conforme")}
                        >
                          Conforme
                        </button>
                        <button
                          type="button"
                          disabled={somenteLeitura}
                          className={`${styles.toggleBtn} ${resposta?.resultado === "nao_conforme" ? styles.toggleNaoConformeAtivo : ""}`}
                          onClick={() => definirResultado(item.itemId, "nao_conforme")}
                        >
                          Não conforme
                        </button>
                        <button
                          type="button"
                          disabled={somenteLeitura}
                          className={`${styles.toggleBtn} ${resposta?.resultado === "nao_aplicavel" ? styles.toggleNaoAplicavelAtivo : ""}`}
                          onClick={() => definirResultado(item.itemId, "nao_aplicavel")}
                        >
                          Não aplicável
                        </button>
                      </div>

                      {mostrarObservacao && (
                        <div className={styles.observacao}>
                          <textarea
                            rows={2}
                            placeholder="Observação obrigatória — descreva a não conformidade..."
                            value={resposta?.observacao ?? ""}
                            disabled={somenteLeitura}
                            onChange={(e) => definirObservacao(item.itemId, e.target.value)}
                          />
                        </div>
                      )}

                      {!somenteLeitura && (
                        <div className={styles.fotoRow}>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => definirFoto(item.itemId, e.target.files?.[0] ?? null)}
                          />
                          {(resposta?.fotoBase64 ?? resposta?.fotoUrl) && (
                            <img
                              src={resposta?.fotoBase64 ?? resposta?.fotoUrl ?? undefined}
                              alt="Evidência do item"
                              className={styles.fotoPreview}
                            />
                          )}
                        </div>
                      )}
                      {somenteLeitura && resposta?.fotoUrl && (
                        <div className={styles.fotoRow}>
                          <img src={resposta.fotoUrl} alt="Evidência do item" className={styles.fotoPreview} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {dados.preenchidoPorNome && (
                <p className={styles.aviso}>
                  Último salvamento por {dados.preenchidoPorNome}
                  {dados.preenchidoEm ? ` em ${new Date(dados.preenchidoEm).toLocaleString("pt-BR")}` : ""}.
                </p>
              )}
            </>
          )}
        </div>

        <div className={pageStyles.modalFooter}>
          <button type="button" className={pageStyles.btnGhost} onClick={onClose}>
            Fechar
          </button>
          {!somenteLeitura && dados?.requerChecklist && (
            <>
              <button
                type="button"
                className={pageStyles.btnGhost}
                disabled={salvando !== null}
                onClick={salvarProgresso}
              >
                {salvando === "progresso" ? "Salvando…" : "Salvar Progresso"}
              </button>
              <button
                type="button"
                className={pageStyles.btnPrimary}
                disabled={salvando !== null || !podeFinalizar}
                title={!podeFinalizar ? "Responda todos os itens obrigatórios para finalizar" : undefined}
                onClick={finalizar}
              >
                {salvando === "finalizar" ? "Finalizando…" : "Finalizar Checklist"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
