"use client";

import { useEffect, useState } from "react";
import styles from "./ChecklistSeguranca.module.css";
import pageStyles from "../app/(app)/reservas/page.module.css";
import { apiFetch } from "../lib/api";

interface ChecklistItemApi {
  itemId: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  conforme: boolean | null;
  observacao: string | null;
  fotoUrl: string | null;
}

interface ChecklistReservaApi {
  requerChecklist: boolean;
  todosConformes: boolean | null;
  preenchidoPorNome: string | null;
  preenchidoEm: string | null;
  itens: ChecklistItemApi[];
}

interface RespostaLocal {
  conforme: boolean | null;
  observacao: string;
  fotoBase64: string | null;
  fotoUrl: string | null;
}

interface ChecklistSegurancaProps {
  reservaId: string;
  somenteLeitura: boolean;
  onAtualizado?: (todosConformes: boolean | null) => void;
}

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

// S8 — RF-CHK-02/03/04, RN-CHK-01/02: preenchimento do checklist de segurança
// embutido no Detalhe da Reserva. Só é renderizado quando a plataforma exige
// checklist (elevatória/andaime — RN-RES-12); o backend é sempre a fonte de
// verdade do bloqueio de "Iniciar Uso", esta seção apenas espelha o estado.
export function ChecklistSeguranca({ reservaId, somenteLeitura, onAtualizado }: ChecklistSegurancaProps) {
  const [carregando, setCarregando] = useState(true);
  const [dados, setDados] = useState<ChecklistReservaApi | null>(null);
  const [respostas, setRespostas] = useState<Record<string, RespostaLocal>>({});
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const resultado = await apiFetch<ChecklistReservaApi>(`/api/v1/reservas/${reservaId}/checklist`);
      setDados(resultado);
      const mapa: Record<string, RespostaLocal> = {};
      for (const item of resultado.itens) {
        mapa[item.itemId] = {
          conforme: item.conforme,
          observacao: item.observacao ?? "",
          fotoBase64: null,
          fotoUrl: item.fotoUrl,
        };
      }
      setRespostas(mapa);
      onAtualizado?.(resultado.todosConformes);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar checklist.");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservaId]);

  function definirConforme(itemId: string, conforme: boolean) {
    setRespostas((atual) => ({
      ...atual,
      [itemId]: { ...atual[itemId], conforme },
    }));
  }

  function definirObservacao(itemId: string, observacao: string) {
    setRespostas((atual) => ({
      ...atual,
      [itemId]: { ...atual[itemId], observacao },
    }));
  }

  async function definirFoto(itemId: string, arquivo: File | null) {
    if (!arquivo) return;
    const base64 = await lerArquivoComoBase64(arquivo);
    setRespostas((atual) => ({
      ...atual,
      [itemId]: { ...atual[itemId], fotoBase64: base64 },
    }));
  }

  async function salvar() {
    if (!dados) return;
    setErro(null);

    const respostasParaEnvio = dados.itens
      .filter((item) => respostas[item.itemId]?.conforme !== null)
      .map((item) => {
        const resposta = respostas[item.itemId];
        return {
          itemId: item.itemId,
          conforme: resposta.conforme as boolean,
          observacao: resposta.observacao.trim() || undefined,
          fotoBase64: resposta.fotoBase64 ?? undefined,
        };
      });

    const itensObrigatoriosSemResposta = dados.itens.filter(
      (item) => item.obrigatorio && respostas[item.itemId]?.conforme === null
    );
    if (itensObrigatoriosSemResposta.length > 0) {
      setErro("Responda todos os itens obrigatórios (conforme ou não conforme) antes de salvar.");
      return;
    }
    const naoConformeSemObservacao = respostasParaEnvio.find(
      (r) => !r.conforme && !r.observacao
    );
    if (naoConformeSemObservacao) {
      setErro("Todo item não conforme exige uma observação preenchida.");
      return;
    }

    setSalvando(true);
    try {
      await apiFetch(`/api/v1/reservas/${reservaId}/checklist`, {
        method: "PUT",
        body: JSON.stringify({ respostas: respostasParaEnvio }),
      });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar checklist.");
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <div className={styles.wrap}>
        <div className={styles.title}>Checklist de Segurança</div>
        <p className={styles.aviso}>Carregando…</p>
      </div>
    );
  }

  if (erro && !dados) {
    return (
      <div className={styles.wrap}>
        <div className={styles.title}>Checklist de Segurança</div>
        <p className={styles.aviso}>{erro}</p>
      </div>
    );
  }

  if (!dados || !dados.requerChecklist) {
    return null;
  }

  const badgeClasse =
    dados.todosConformes === true
      ? styles.statusOk
      : dados.todosConformes === false
        ? styles.statusBloqueado
        : styles.statusPendente;
  const badgeTexto =
    dados.todosConformes === true
      ? "Aprovado — libera Iniciar Uso"
      : dados.todosConformes === false
        ? "Reprovado — Iniciar Uso bloqueado"
        : "Pendente de preenchimento";

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.title}>Checklist de Segurança (NR-18/NR-35)</span>
        <span className={`${styles.statusBadge} ${badgeClasse}`}>{badgeTexto}</span>
      </div>

      {erro && <p className={`${styles.aviso} ${styles.avisoBloqueio}`}>{erro}</p>}

      <div className={styles.itens}>
        {dados.itens.map((item) => {
          const resposta = respostas[item.itemId];
          const mostrarObservacao = resposta?.conforme === false;
          return (
            <div key={item.itemId} className={styles.item}>
              <div className={styles.itemHeader}>
                <span className={styles.itemDescricao}>
                  {item.descricao}
                  {item.obrigatorio && <span className={styles.itemObrigatorio}>*</span>}
                </span>
                <div className={styles.toggleGroup}>
                  <button
                    type="button"
                    disabled={somenteLeitura}
                    className={`${styles.toggleBtn} ${resposta?.conforme === true ? styles.toggleConformeAtivo : ""}`}
                    onClick={() => definirConforme(item.itemId, true)}
                  >
                    Conforme
                  </button>
                  <button
                    type="button"
                    disabled={somenteLeitura}
                    className={`${styles.toggleBtn} ${resposta?.conforme === false ? styles.toggleNaoConformeAtivo : ""}`}
                    onClick={() => definirConforme(item.itemId, false)}
                  >
                    Não conforme
                  </button>
                </div>
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
          Último preenchimento por {dados.preenchidoPorNome}
          {dados.preenchidoEm ? ` em ${new Date(dados.preenchidoEm).toLocaleString("pt-BR")}` : ""}.
        </p>
      )}

      {!somenteLeitura && (
        <div className={styles.footer}>
          <button type="button" className={pageStyles.btnPrimary} disabled={salvando} onClick={salvar}>
            {salvando ? "Salvando…" : "Salvar Checklist"}
          </button>
        </div>
      )}
    </div>
  );
}
