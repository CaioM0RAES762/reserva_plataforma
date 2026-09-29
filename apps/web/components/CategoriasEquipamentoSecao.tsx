"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import styles from "./Admin.module.css";
import local from "./ConfiguracoesClient.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";

export interface CategoriaEquipamento {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
  emUso: number;
}

/* Categorias de equipamento — lista compacta com edição inline. Cada ação é gravada na
 * hora (não depende do "Salvar alterações" das políticas acima). Categoria sem plataformas
 * pode ser excluída; em uso, só desativada (some dos novos cadastros, as antigas não mudam).
 * Âncora #categorias-equipamento: o atalho "+ Cadastrar categoria" do formulário de
 * plataforma chega aqui já com a seção em vista e o foco no título. */
export const ID_SECAO_CATEGORIAS = "categorias-equipamento";

export function CategoriasEquipamentoSecao() {
  const [categorias, setCategorias] = useState<CategoriaEquipamento[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [nomeEdicao, setNomeEdicao] = useState("");
  const [criando, setCriando] = useState(false);
  const [nomeNovo, setNomeNovo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [excluindoId, setExcluindoId] = useState<string | null>(null);
  const inputNovoRef = useRef<HTMLInputElement>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const carregar = useCallback(async () => {
    try {
      setCategorias(await apiFetch<CategoriaEquipamento[]>("/api/v1/categorias-equipamento"));
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar categorias."));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => {
    if (criando) inputNovoRef.current?.focus();
  }, [criando]);

  // Veio do atalho do formulário de plataforma: rola até a seção (depois de a lista
  // carregar, para a posição não pular) e põe o foco no título.
  useEffect(() => {
    if (carregando || window.location.hash !== `#${ID_SECAO_CATEGORIAS}`) return;
    tituloRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    tituloRef.current?.focus({ preventScroll: true });
  }, [carregando]);

  function substituir(atualizada: CategoriaEquipamento) {
    setCategorias((lista) => lista.map((c) => (c.id === atualizada.id ? atualizada : c)));
  }

  async function executar(acao: () => Promise<void>) {
    setErro(null);
    setOcupado(true);
    try {
      await acao();
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível salvar a categoria."));
    } finally {
      setOcupado(false);
    }
  }

  function handleCriar(event: FormEvent) {
    event.preventDefault();
    const nome = nomeNovo.trim();
    if (!nome) return;
    executar(async () => {
      const criada = await apiFetch<CategoriaEquipamento>("/api/v1/categorias-equipamento", {
        method: "POST",
        body: JSON.stringify({ nome }),
      });
      setCategorias((lista) => [...lista, criada]);
      setNomeNovo("");
      setCriando(false);
    });
  }

  function handleRenomear(event: FormEvent, categoria: CategoriaEquipamento) {
    event.preventDefault();
    const nome = nomeEdicao.trim();
    if (!nome || nome === categoria.nome) {
      setEditandoId(null);
      return;
    }
    executar(async () => {
      substituir(
        await apiFetch<CategoriaEquipamento>(`/api/v1/categorias-equipamento/${categoria.id}`, {
          method: "PUT",
          body: JSON.stringify({ nome }),
        })
      );
      setEditandoId(null);
    });
  }

  function handleExcluir(categoria: CategoriaEquipamento) {
    executar(async () => {
      await apiFetch(`/api/v1/categorias-equipamento/${categoria.id}`, {
        method: "DELETE",
      });
      setCategorias((lista) => lista.filter((c) => c.id !== categoria.id));
      setExcluindoId(null);
    });
  }

  function handleAlternarAtivo(categoria: CategoriaEquipamento) {
    executar(async () => {
      substituir(
        await apiFetch<CategoriaEquipamento>(`/api/v1/categorias-equipamento/${categoria.id}`, {
          method: "PUT",
          body: JSON.stringify({ ativo: !categoria.ativo }),
        })
      );
    });
  }

  return (
    <section
      id={ID_SECAO_CATEGORIAS}
      className={`${local.superficie} ${local.superficieSeparada}`}
      aria-labelledby="cfg-secao-categorias"
    >
      <div className={local.secao}>
        <h2 id="cfg-secao-categorias" ref={tituloRef} tabIndex={-1} className={local.secaoTitulo}>
          Categorias de equipamento
        </h2>
        <p className={local.secaoTexto}>
          Opções do campo Categoria no cadastro de plataformas. Categorias inativas não aparecem em novos cadastros, mas
          continuam nas plataformas que já as usam. Só é possível excluir categoria sem plataformas.
        </p>

        {erro && (
          <div className={styles.error} role="alert">
            {erro}
          </div>
        )}

        {carregando ? (
          <p className={local.nota}>Carregando...</p>
        ) : (
          <ul className={local.categorias}>
            {categorias.map((categoria) => (
              <li key={categoria.id} className={local.categoria}>
                {editandoId === categoria.id ? (
                  <form className={local.categoriaForm} onSubmit={(e) => handleRenomear(e, categoria)}>
                    <input
                      className={`${local.input} ${local.inputNome}`}
                      value={nomeEdicao}
                      onChange={(e) => setNomeEdicao(e.target.value)}
                      maxLength={60}
                      aria-label={`Novo nome para ${categoria.nome}`}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditandoId(null);
                      }}
                    />
                    <button type="submit" className={styles.btnIcon} disabled={ocupado || !nomeEdicao.trim()}>
                      Salvar
                    </button>
                    <button type="button" className={styles.btnGhost} onClick={() => setEditandoId(null)}>
                      Cancelar
                    </button>
                  </form>
                ) : (
                  <>
                    <span className={`${local.categoriaNome} ${categoria.ativo ? "" : local.categoriaNomeInativa}`}>
                      {categoria.nome}
                    </span>
                    <span className={local.categoriaUso}>
                      {categoria.emUso === 0
                        ? "Sem plataformas"
                        : `${categoria.emUso} plataforma${categoria.emUso > 1 ? "s" : ""}`}
                    </span>
                    <span className={categoria.ativo ? local.estadoAtiva : local.estadoInativa}>
                      {categoria.ativo ? "Ativa" : "Inativa"}
                    </span>
                    <span className={local.categoriaAcoes}>
                      {excluindoId === categoria.id ? (
                        <>
                          <span className={local.categoriaUso}>Excluir?</span>
                          <button
                            type="button"
                            className={`${local.linkAcao} ${local.linkAcaoPerigo}`}
                            disabled={ocupado}
                            onClick={() => handleExcluir(categoria)}
                          >
                            Sim, excluir
                          </button>
                          <button type="button" className={local.linkAcao} onClick={() => setExcluindoId(null)}>
                            Não
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={local.linkAcao}
                            disabled={ocupado}
                            onClick={() => {
                              setEditandoId(categoria.id);
                              setNomeEdicao(categoria.nome);
                            }}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className={local.linkAcao}
                            disabled={ocupado}
                            onClick={() => handleAlternarAtivo(categoria)}
                          >
                            {categoria.ativo ? "Desativar" : "Ativar"}
                          </button>
                          {/* Excluir só existe sem plataformas vinculadas; em uso, desativar. */}
                          {categoria.emUso === 0 && (
                            <button
                              type="button"
                              className={`${local.linkAcao} ${local.linkAcaoPerigo}`}
                              disabled={ocupado}
                              onClick={() => setExcluindoId(categoria.id)}
                            >
                              Excluir
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {criando ? (
          <form className={`${local.categoriaForm} ${local.categoriaNova}`} onSubmit={handleCriar}>
            <input
              ref={inputNovoRef}
              className={`${local.input} ${local.inputNome}`}
              value={nomeNovo}
              onChange={(e) => setNomeNovo(e.target.value)}
              maxLength={60}
              placeholder="Ex.: Empilhadeira"
              aria-label="Nome da nova categoria"
              onKeyDown={(e) => {
                if (e.key === "Escape") setCriando(false);
              }}
            />
            <button type="submit" className={styles.btnIcon} disabled={ocupado || !nomeNovo.trim()}>
              Adicionar
            </button>
            <button type="button" className={styles.btnGhost} onClick={() => setCriando(false)}>
              Cancelar
            </button>
          </form>
        ) : (
          !carregando && (
            <button type="button" className={local.novaCategoria} onClick={() => setCriando(true)}>
              <Plus size={14} aria-hidden="true" /> Nova categoria
            </button>
          )
        )}
      </div>
    </section>
  );
}
