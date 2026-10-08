"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import type { PlataformaComResponsaveis } from "@plataformares/shared";
import styles from "./Admin.module.css";
import local from "./ConfiguracoesClient.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";

/* Responsáveis por plataforma (migration 0030). O Admin atribui gestores que passam a
 * gerenciar a plataforma (dados, status, imagens) mesmo sendo de outro setor. Cada ação grava
 * na hora, com confirmação — não depende do "Salvar alterações" das políticas acima. A API
 * valida tudo de novo (só Admin; só Gestor ativo); esta tela só organiza a escolha. */

interface GestorOpcao {
  id: string;
  nome: string;
  email: string;
  setorNome: string | null;
}

interface SetorOpcao {
  id: string;
  nome: string;
}

type Confirmacao =
  | { tipo: "remover"; plataforma: PlataformaComResponsaveis; gestorId: string; gestorNome: string }
  | { tipo: "atribuir"; plataforma: PlataformaComResponsaveis; gestorIds: string[] };

export function ResponsaveisPlataformaSecao() {
  const [plataformas, setPlataformas] = useState<PlataformaComResponsaveis[]>([]);
  const [gestores, setGestores] = useState<GestorOpcao[]>([]);
  const [setores, setSetores] = useState<SetorOpcao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [setorFiltro, setSetorFiltro] = useState("");
  const buscaAtrasada = useDebounce(busca);
  // Plataforma com o seletor de gestores aberto, a busca dentro dele e os marcados.
  const [adicionandoEm, setAdicionandoEm] = useState<string | null>(null);
  const [buscaGestor, setBuscaGestor] = useState("");
  const [marcados, setMarcados] = useState<string[]>([]);
  const [confirmacao, setConfirmacao] = useState<Confirmacao | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const params = new URLSearchParams();
      if (buscaAtrasada.trim()) params.set("q", buscaAtrasada.trim());
      if (setorFiltro) params.set("setor", setorFiltro);
      const query = params.toString();
      setPlataformas(await apiFetch<PlataformaComResponsaveis[]>(`/api/v1/plataformas-responsaveis${query ? `?${query}` : ""}`));
      setErro(null);
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível carregar os responsáveis."));
    } finally {
      setCarregando(false);
    }
  }, [buscaAtrasada, setorFiltro]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    // Só Gestores ATIVOS são elegíveis (o Admin já tem acesso global).
    apiFetch<GestorOpcao[]>("/api/v1/usuarios?perfil=gestor_setor&status=ativo")
      .then(setGestores)
      .catch(() => setGestores([]));
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetores)
      .catch(() => setSetores([]));
  }, []);

  function abrirSeletor(plataformaId: string) {
    setAdicionandoEm(plataformaId);
    setBuscaGestor("");
    setMarcados([]);
    setConfirmacao(null);
    setSucesso(null);
  }

  const gestoresFiltrados = useMemo(() => {
    const termo = buscaGestor.trim().toLowerCase();
    const plataforma = plataformas.find((p) => p.plataformaId === adicionandoEm);
    const atuais = new Set((plataforma?.responsaveis ?? []).map((r) => r.gestorId.toLowerCase()));
    return gestores.filter(
      (g) =>
        !atuais.has(g.id.toLowerCase()) &&
        (!termo || g.nome.toLowerCase().includes(termo) || (g.setorNome ?? "").toLowerCase().includes(termo))
    );
  }, [buscaGestor, gestores, plataformas, adicionandoEm]);

  async function executarConfirmacao() {
    if (!confirmacao) return;
    setOcupado(true);
    setErro(null);
    try {
      const { plataforma } = confirmacao;
      const atualizada =
        confirmacao.tipo === "atribuir"
          ? await apiFetch<PlataformaComResponsaveis>(`/api/v1/plataformas/${plataforma.plataformaId}/responsaveis`, {
              method: "POST",
              body: JSON.stringify({ gestorIds: confirmacao.gestorIds }),
            })
          : await apiFetch<PlataformaComResponsaveis>(
              `/api/v1/plataformas/${plataforma.plataformaId}/responsaveis/${confirmacao.gestorId}`,
              { method: "DELETE" }
            );
      setPlataformas((lista) => lista.map((p) => (p.plataformaId === atualizada.plataformaId ? atualizada : p)));
      setSucesso(
        confirmacao.tipo === "atribuir"
          ? `${confirmacao.gestorIds.length === 1 ? "Responsável atribuído" : "Responsáveis atribuídos"} a ${plataforma.codigo}.`
          : `${confirmacao.gestorNome} não é mais responsável por ${plataforma.codigo}.`
      );
      setConfirmacao(null);
      setAdicionandoEm(null);
      setMarcados([]);
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível salvar a alteração."));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className={`${local.superficie} ${local.superficieSeparada}`} aria-labelledby="cfg-secao-responsaveis">
      <div className={local.secao}>
        <h2 id="cfg-secao-responsaveis" className={local.secaoTitulo}>
          Responsáveis por plataformas
        </h2>
        <p className={local.secaoTexto}>
          Gestores atribuídos aqui gerenciam a plataforma (dados, status e imagens) mesmo sendo de outro setor. Não
          ganham nenhum acesso administrativo além disso.
        </p>

        <div className={local.responsaveisFiltros}>
          <input
            type="search"
            className={styles.search}
            placeholder="Buscar plataforma por nome ou código..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label="Buscar plataforma"
          />
          <select
            className={local.input}
            value={setorFiltro}
            onChange={(e) => setSetorFiltro(e.target.value)}
            aria-label="Filtrar por setor da plataforma"
          >
            <option value="">Todos os setores</option>
            <option value="sem_setor">Sem setor definido</option>
            {setores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        </div>

        {erro && (
          <div className={styles.error} role="alert">
            {erro}
          </div>
        )}
        {sucesso && (
          <div className={styles.success} role="status">
            {sucesso}
          </div>
        )}

        {carregando && plataformas.length === 0 ? (
          <p className={local.nota}>Carregando...</p>
        ) : plataformas.length === 0 ? (
          <p className={local.nota}>Nenhuma plataforma encontrada com esses filtros.</p>
        ) : (
          <ul className={local.responsaveisLista} data-testid="responsaveis-lista">
            {plataformas.map((p) => (
              <li key={p.plataformaId} className={local.responsavelItem}>
                <div className={local.responsavelCabecalho}>
                  <span className={local.categoriaNome}>
                    {p.codigo} · {p.nome}
                  </span>
                  <span className={local.categoriaUso}>
                    {p.categoriaNome ?? "Sem categoria"} · {p.setorNome ?? "Sem setor definido"}
                  </span>
                </div>

                <div className={local.responsavelChips}>
                  {p.responsaveis.length === 0 && <span className={local.categoriaUso}>Nenhum responsável atribuído.</span>}
                  {p.responsaveis.map((r) => (
                    <span key={r.gestorId} className={`${local.chipResponsavel} ${r.concedeAcesso ? "" : local.chipSemAcesso}`}>
                      <span title={r.email}>
                        {r.nome}
                        {r.setorNome ? ` · ${r.setorNome}` : ""}
                        {!r.concedeAcesso && " (sem acesso: inativo ou não é mais gestor)"}
                      </span>
                      <button
                        type="button"
                        className={local.chipRemover}
                        aria-label={`Remover ${r.nome} dos responsáveis por ${p.codigo}`}
                        onClick={() => {
                          setSucesso(null);
                          setConfirmacao({ tipo: "remover", plataforma: p, gestorId: r.gestorId, gestorNome: r.nome });
                        }}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  {adicionandoEm !== p.plataformaId && (
                    <button type="button" className={local.novaCategoria} onClick={() => abrirSeletor(p.plataformaId)}>
                      <Plus size={14} aria-hidden="true" /> Adicionar responsável
                    </button>
                  )}
                </div>

                {adicionandoEm === p.plataformaId && (
                  <div className={local.seletorGestores}>
                    <input
                      type="search"
                      className={local.input}
                      placeholder="Buscar gestor por nome ou setor..."
                      value={buscaGestor}
                      onChange={(e) => setBuscaGestor(e.target.value)}
                      aria-label="Buscar gestor"
                      autoFocus
                    />
                    {gestoresFiltrados.length === 0 ? (
                      <p className={local.nota}>Nenhum gestor ativo disponível.</p>
                    ) : (
                      <ul className={local.gestoresOpcoes}>
                        {gestoresFiltrados.map((g) => (
                          <li key={g.id}>
                            <label className={local.gestorOpcao}>
                              <input
                                type="checkbox"
                                checked={marcados.includes(g.id)}
                                onChange={(e) =>
                                  setMarcados((atual) => (e.target.checked ? [...atual, g.id] : atual.filter((id) => id !== g.id)))
                                }
                              />
                              <span>
                                {g.nome}
                                <span className={local.categoriaUso}> · {g.setorNome ?? "sem setor"}</span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className={local.categoriaAcoes}>
                      <button
                        type="button"
                        className={styles.btnIcon}
                        disabled={marcados.length === 0}
                        onClick={() => setConfirmacao({ tipo: "atribuir", plataforma: p, gestorIds: marcados })}
                      >
                        Atribuir {marcados.length > 0 ? `(${marcados.length})` : ""}
                      </button>
                      <button type="button" className={styles.btnGhost} onClick={() => setAdicionandoEm(null)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                {confirmacao && confirmacao.plataforma.plataformaId === p.plataformaId && (
                  <div className={local.confirmacaoResponsavel} role="alertdialog" aria-label="Confirmar alteração">
                    <span>
                      {confirmacao.tipo === "atribuir"
                        ? `Atribuir ${confirmacao.gestorIds.length} gestor(es) como responsável(is) por ${p.codigo}?`
                        : `Remover ${confirmacao.gestorNome} dos responsáveis por ${p.codigo}? O acesso dado por esta atribuição acaba na hora.`}
                    </span>
                    <span className={local.categoriaAcoes}>
                      <button type="button" className={styles.btnIcon} disabled={ocupado} onClick={() => void executarConfirmacao()}>
                        {ocupado ? "Salvando..." : "Confirmar"}
                      </button>
                      <button type="button" className={styles.btnGhost} disabled={ocupado} onClick={() => setConfirmacao(null)}>
                        Cancelar
                      </button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
