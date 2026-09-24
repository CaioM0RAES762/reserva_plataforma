"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, MoreHorizontal, Pencil, Trash2, TriangleAlert, X } from "lucide-react";
import {
  MAX_IMAGENS_POR_COMENTARIO,
  MIMES_IMAGEM_COMENTARIO,
  type ComentarioPublico,
  type ImagemComentarioPublica,
} from "@plataformares/shared";
import styles from "./ComentariosReserva.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";

export interface ComentariosReservaProps {
  reservaId: string;
}

/** Imagem escolhida no composer, ainda não enviada. */
interface ImagemPendente {
  /** Chave estável para o React — o nome do arquivo pode repetir. */
  chave: string;
  nomeArquivo: string;
  /** data URL, usada tanto para o preview quanto para o envio. */
  dataUrl: string;
}

const TAMANHO_MAXIMO_BYTES = 10 * 1024 * 1024;

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

function formatarCarimbo(iso: string): string {
  const d = new Date(iso);
  const hoje = new Date();
  const mesmoDia =
    d.getFullYear() === hoje.getFullYear() && d.getMonth() === hoje.getMonth() && d.getDate() === hoje.getDate();
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (mesmoDia) return hora;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "")} · ${hora}`;
}

function iniciais(nome: string): string {
  return nome
    .trim()
    .split(/\s+/)
    .map((parte) => parte[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Timeline operacional da reserva — o registro do que aconteceu durante o uso.
 *
 * Substitui as abas "Anexos | Comentários": a imagem passa a pertencer ao comentário que a
 * explica, em vez de ser um arquivo solto sem contexto. Um comentário pode ser marcado como
 * NÃO CONFORMIDADE, e nesse caso o próprio texto é a descrição formal do problema — é o
 * ponto único de registro, consolidando o antigo formulário separado de "ocorrência".
 *
 * Marcar como não conformidade NÃO dispara automação: não coloca a plataforma em
 * manutenção, não cancela a reserva, não impede a conclusão. O requisito é registrar e
 * identificar.
 *
 * Autor (ou admin) pode editar/excluir o próprio comentário — a permissão vem pronta do
 * backend em cada entrada (podeEditar/podeExcluir), nunca decidida aqui.
 */
export function ComentariosReserva({ reservaId }: ComentariosReservaProps) {
  const [entradas, setEntradas] = useState<ComentarioPublico[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [mensagem, setMensagem] = useState("");
  const [naoConformidade, setNaoConformidade] = useState(false);
  const [imagens, setImagens] = useState<ImagemPendente[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [ampliada, setAmpliada] = useState<{ url: string; alt: string } | null>(null);

  // Edição: o mesmo composer é reaproveitado (mensagem/imagens acima), só ganha um "contexto"
  // de qual comentário está sendo editado e a lista das imagens JÁ salvas dele (que podem ser
  // removidas sem reenviar em base64 — só as novas passam por `imagens`).
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [imagensExistentes, setImagensExistentes] = useState<ImagemComentarioPublica[]>([]);
  const [menuAbertoId, setMenuAbertoId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setEntradas(await apiFetch<ComentarioPublico[]>(`/api/v1/reservas/${reservaId}/comentarios`));
      setErro(null);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar os comentários."));
    } finally {
      setCarregando(false);
    }
  }, [reservaId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Fecha o lightbox com Esc — sem isto, quem navega por teclado fica preso na imagem.
  useEffect(() => {
    if (!ampliada) return;
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") setAmpliada(null);
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [ampliada]);

  // Fecha o menu "..." ao clicar fora ou pressionar Esc — mesmo padrão do menu da conta
  // (SidebarUserMenu), só que com um único listener cobrindo qualquer entrada da timeline.
  useEffect(() => {
    if (!menuAbertoId) return;
    function aoClicarFora(evento: MouseEvent) {
      const alvo = evento.target as Element | null;
      if (!alvo?.closest("[data-menu-comentario]")) setMenuAbertoId(null);
    }
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") setMenuAbertoId(null);
    }
    document.addEventListener("mousedown", aoClicarFora);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("mousedown", aoClicarFora);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [menuAbertoId]);

  const totalImagensAtual = imagensExistentes.length + imagens.length;

  async function adicionarImagens(lista: FileList | null) {
    if (!lista || lista.length === 0) return;
    setErro(null);
    const novas: ImagemPendente[] = [];

    for (const arquivo of Array.from(lista)) {
      if (totalImagensAtual + novas.length >= MAX_IMAGENS_POR_COMENTARIO) {
        setErro(`Máximo de ${MAX_IMAGENS_POR_COMENTARIO} imagens por comentário.`);
        break;
      }
      // Validação local por MIME e tamanho: dá resposta imediata, mas é conveniência —
      // o backend reverifica os bytes reais, que é a barreira que de fato vale.
      if (!(MIMES_IMAGEM_COMENTARIO as readonly string[]).includes(arquivo.type)) {
        setErro("Envie apenas imagens JPEG, PNG ou WebP.");
        continue;
      }
      if (arquivo.size > TAMANHO_MAXIMO_BYTES) {
        setErro(`"${arquivo.name}" excede o limite de 10 MB.`);
        continue;
      }
      novas.push({
        chave: `${arquivo.name}-${arquivo.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        nomeArquivo: arquivo.name,
        dataUrl: await lerArquivoComoBase64(arquivo),
      });
    }

    if (novas.length > 0) setImagens((atual) => [...atual, ...novas]);
    if (inputRef.current) inputRef.current.value = "";
  }

  function removerImagem(chave: string) {
    setImagens((atual) => atual.filter((imagem) => imagem.chave !== chave));
  }

  function removerImagemExistente(imagemId: string) {
    setImagensExistentes((atual) => atual.filter((imagem) => imagem.id !== imagemId));
  }

  function iniciarEdicao(entrada: ComentarioPublico) {
    setMenuAbertoId(null);
    setErro(null);
    setEditandoId(entrada.id);
    setMensagem(entrada.mensagem);
    setImagensExistentes(entrada.imagens);
    setImagens([]);
    // tipo é imutável na edição — reflete só para o composer manter a mesma aparência
    // (friso/selo) do comentário original, o checkbox some (ver JSX abaixo).
    setNaoConformidade(entrada.tipo === "nao_conformidade");
  }

  function cancelarEdicao() {
    setEditandoId(null);
    setMensagem("");
    setImagensExistentes([]);
    setImagens([]);
    setNaoConformidade(false);
    setErro(null);
  }

  async function excluir(comentarioId: string) {
    setMenuAbertoId(null);
    if (!confirm("Excluir este comentário? Esta ação não pode ser desfeita.")) return;
    setErro(null);
    try {
      await apiFetch(`/api/v1/reservas/${reservaId}/comentarios/${comentarioId}`, { method: "DELETE" });
      if (editandoId === comentarioId) cancelarEdicao();
      await carregar();
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao excluir o comentário."));
    }
  }

  const textoPreenchido = mensagem.trim().length > 0;
  /* Comentário comum aceita só imagem ("cheguei, está assim"). Não conformidade exige
     texto: a foto mostra, mas não diz o que está errado nem o que se espera de quem for
     tratá-la depois. Mesma regra do schema no backend. */
  const faltaDescricaoNc = naoConformidade && mensagem.trim().length < 3;
  const podeEnviar = !enviando && !faltaDescricaoNc && (textoPreenchido || totalImagensAtual > 0);

  async function enviar() {
    if (!podeEnviar) return;
    setEnviando(true);
    setErro(null);
    try {
      if (editandoId) {
        const original = entradas.find((entrada) => entrada.id === editandoId);
        const idsRestantes = new Set(imagensExistentes.map((imagem) => imagem.id));
        const imagensRemover = (original?.imagens ?? [])
          .filter((imagem) => !idsRestantes.has(imagem.id))
          .map((imagem) => imagem.id);
        await apiFetch(`/api/v1/reservas/${reservaId}/comentarios/${editandoId}`, {
          method: "PATCH",
          body: JSON.stringify({
            mensagem: mensagem.trim(),
            imagensRemover,
            imagensAdicionar: imagens.map((imagem) => ({
              nomeArquivo: imagem.nomeArquivo,
              arquivoBase64: imagem.dataUrl,
            })),
          }),
        });
        cancelarEdicao();
      } else {
        await apiFetch(`/api/v1/reservas/${reservaId}/comentarios`, {
          method: "POST",
          body: JSON.stringify({
            mensagem: mensagem.trim(),
            tipo: naoConformidade ? "nao_conformidade" : "comentario",
            imagens: imagens.map((imagem) => ({
              nomeArquivo: imagem.nomeArquivo,
              arquivoBase64: imagem.dataUrl,
            })),
          }),
        });
        setMensagem("");
        setImagens([]);
        setNaoConformidade(false);
      }
      await carregar();
    } catch (err) {
      setErro(mensagemDeErro(err, editandoId ? "Erro ao salvar o comentário." : "Erro ao enviar o comentário."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className={styles.secao}>
      <h3 className={styles.tituloSecao}>Comentários</h3>

      {erro && (
        <div className={styles.erro} role="alert">
          {erro}
        </div>
      )}

      {carregando ? (
        <p className={styles.vazio}>Carregando...</p>
      ) : entradas.length === 0 ? (
        <p className={styles.vazio}>Nenhum comentário ainda.</p>
      ) : (
        <ol className={styles.timeline}>
          {entradas.map((entrada) => {
            const ehNc = entrada.tipo === "nao_conformidade";
            const temMenu = (entrada.podeEditar || entrada.podeExcluir) && !entrada.historico;
            return (
              <li
                key={entrada.id}
                className={`${styles.entrada} ${ehNc ? styles.entradaNaoConformidade : ""} ${
                  editandoId === entrada.id ? styles.entradaEmEdicao : ""
                }`}
              >
                {ehNc && (
                  <span className={styles.selo}>
                    <TriangleAlert size={12} strokeWidth={2.25} aria-hidden="true" />
                    Não conformidade
                  </span>
                )}

                <div className={styles.cabecalho}>
                  <span className={styles.avatar} aria-hidden="true">
                    {iniciais(entrada.usuarioNome)}
                  </span>
                  <span className={styles.autor}>{entrada.usuarioNome}</span>
                  <span className={styles.carimbo}>{formatarCarimbo(entrada.criadoEm)}</span>
                  {entrada.editado && <span className={styles.rotuloEditado}>editado</span>}
                  {/* Entradas trazidas do modelo anterior (anexos e ocorrências) ficam
                      identificadas em vez de se disfarçarem de comentário novo. */}
                  {entrada.historico && <span className={styles.rotuloHistorico}>{entrada.historico.rotulo}</span>}

                  {temMenu && (
                    <div className={styles.menuComentario} data-menu-comentario>
                      <button
                        type="button"
                        className={styles.menuGatilho}
                        aria-haspopup="menu"
                        aria-expanded={menuAbertoId === entrada.id}
                        aria-label="Ações do comentário"
                        onClick={() => setMenuAbertoId((atual) => (atual === entrada.id ? null : entrada.id))}
                      >
                        <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      {menuAbertoId === entrada.id && (
                        <div className={styles.menuLista} role="menu">
                          {entrada.podeEditar && (
                            <button
                              type="button"
                              role="menuitem"
                              className={styles.menuItem}
                              onClick={() => iniciarEdicao(entrada)}
                            >
                              <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                              Editar
                            </button>
                          )}
                          {entrada.podeExcluir && (
                            <button
                              type="button"
                              role="menuitem"
                              className={`${styles.menuItem} ${styles.menuItemPerigo}`}
                              onClick={() => excluir(entrada.id)}
                            >
                              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                              Excluir
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {entrada.mensagem && <p className={styles.mensagem}>{entrada.mensagem}</p>}

                {entrada.imagens.length > 0 && (
                  <div className={styles.miniaturas}>
                    {entrada.imagens.map((imagem) => (
                      <button
                        key={imagem.id}
                        type="button"
                        className={styles.miniatura}
                        onClick={() => setAmpliada({ url: imagem.url, alt: imagem.nomeArquivo })}
                        aria-label={`Ampliar imagem ${imagem.nomeArquivo}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={imagem.url} alt={imagem.nomeArquivo} loading="lazy" decoding="async" />
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className={`${styles.composer} ${naoConformidade ? styles.composerNaoConformidade : ""}`}>
        {editandoId && (
          <div className={styles.avisoEdicao}>
            <span>Editando comentário</span>
            <button type="button" className={styles.linkCancelar} onClick={cancelarEdicao}>
              Cancelar
            </button>
          </div>
        )}

        <label htmlFor="comentario-mensagem" className={styles.visuallyHidden}>
          {naoConformidade ? "Descreva a não conformidade" : "Escreva um comentário"}
        </label>
        <textarea
          id="comentario-mensagem"
          className={styles.campoTexto}
          rows={3}
          maxLength={1000}
          placeholder={naoConformidade ? "Descreva a não conformidade..." : "Escreva um comentário..."}
          value={mensagem}
          onChange={(e) => setMensagem(e.target.value)}
          aria-invalid={faltaDescricaoNc ? true : undefined}
          aria-describedby={faltaDescricaoNc ? "comentario-erro-nc" : undefined}
        />

        {faltaDescricaoNc && (
          <p id="comentario-erro-nc" className={styles.erroCampo} role="alert">
            Descreva a não conformidade antes de registrar.
          </p>
        )}

        {(imagensExistentes.length > 0 || imagens.length > 0) && (
          <div className={styles.previews}>
            {imagensExistentes.map((imagem) => (
              <div key={imagem.id} className={styles.preview}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagem.url} alt={imagem.nomeArquivo} />
                <button
                  type="button"
                  className={styles.removerPreview}
                  onClick={() => removerImagemExistente(imagem.id)}
                  aria-label={`Remover ${imagem.nomeArquivo}`}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            ))}
            {imagens.map((imagem) => (
              <div key={imagem.chave} className={styles.preview}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagem.dataUrl} alt={imagem.nomeArquivo} />
                <button
                  type="button"
                  className={styles.removerPreview}
                  onClick={() => removerImagem(imagem.chave)}
                  aria-label={`Remover ${imagem.nomeArquivo}`}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.acoes}>
          <input
            ref={inputRef}
            type="file"
            accept={MIMES_IMAGEM_COMENTARIO.join(",")}
            multiple
            className={styles.visuallyHidden}
            onChange={(e) => adicionarImagens(e.target.files)}
          />
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => inputRef.current?.click()}
            disabled={enviando || totalImagensAtual >= MAX_IMAGENS_POR_COMENTARIO}
          >
            <ImagePlus size={15} strokeWidth={1.75} aria-hidden="true" />
            Adicionar imagem
          </button>

          {/* tipo é imutável na edição — sem checkbox, o composer só mostra o estilo do
              tipo original (ver classe composerNaoConformidade acima). */}
          {!editandoId && (
            <label className={styles.marcarNc}>
              <input
                type="checkbox"
                checked={naoConformidade}
                onChange={(e) => setNaoConformidade(e.target.checked)}
                disabled={enviando}
              />
              Registrar como não conformidade
            </label>
          )}

          <button type="button" className={styles.btnEnviar} onClick={enviar} disabled={!podeEnviar}>
            {enviando ? "Salvando..." : editandoId ? "Salvar" : "Enviar"}
          </button>
        </div>
      </div>

      {ampliada && (
        // Lightbox: a miniatura mantém a timeline compacta; a imagem em tamanho real só
        // aparece quando pedida.
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={`Imagem ${ampliada.alt}`}
          onClick={() => setAmpliada(null)}
        >
          <button type="button" className={styles.fecharLightbox} aria-label="Fechar imagem">
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ampliada.url} alt={ampliada.alt} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  );
}
