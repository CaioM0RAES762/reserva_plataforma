"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./AnexosComentarios.module.css";
import { apiFetch } from "../lib/api";

interface Anexo {
  id: string;
  nomeArquivo: string;
  tipoMime: string;
  tamanhoBytes: number;
  enviadoPorNome: string;
  url: string;
  criadoEm: string;
}

interface Comentario {
  id: string;
  usuarioId: string;
  usuarioNome: string;
  mensagem: string;
  criadoEm: string;
}

interface AnexosComentariosProps {
  reservaId: string;
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

// RF-RES-14/15: abas "Anexos" (upload drag&drop) e "Comentários" (thread cronológica),
// embutidas no Detalhe da Reserva — mesmo padrão de seção auto-contida de ChecklistSeguranca
// (S8): busca os próprios dados ao montar, sem depender do componente pai.
export function AnexosComentarios({ reservaId }: AnexosComentariosProps) {
  const [aba, setAba] = useState<"anexos" | "comentarios">("anexos");
  const [anexos, setAnexos] = useState<Anexo[]>([]);
  const [comentarios, setComentarios] = useState<Comentario[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState("");
  const [enviandoComentario, setEnviandoComentario] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [listaAnexos, listaComentarios] = await Promise.all([
        apiFetch<Anexo[]>(`/api/v1/reservas/${reservaId}/anexos`),
        apiFetch<Comentario[]>(`/api/v1/reservas/${reservaId}/comentarios`),
      ]);
      setAnexos(listaAnexos);
      setComentarios(listaComentarios);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar anexos/comentários.");
    } finally {
      setCarregando(false);
    }
  }, [reservaId]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function enviarArquivos(arquivos: FileList | File[]) {
    setErro(null);
    setEnviandoArquivo(true);
    try {
      for (const arquivo of Array.from(arquivos)) {
        if (arquivo.size > 10 * 1024 * 1024) {
          setErro(`"${arquivo.name}" excede o limite de 10 MB.`);
          continue;
        }
        const base64 = await lerArquivoComoBase64(arquivo);
        await apiFetch(`/api/v1/reservas/${reservaId}/anexos`, {
          method: "POST",
          body: JSON.stringify({ nomeArquivo: arquivo.name, arquivoBase64: base64 }),
        });
      }
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao enviar arquivo.");
    } finally {
      setEnviandoArquivo(false);
    }
  }

  async function enviarComentario() {
    if (!mensagem.trim()) return;
    setErro(null);
    setEnviandoComentario(true);
    try {
      await apiFetch(`/api/v1/reservas/${reservaId}/comentarios`, {
        method: "POST",
        body: JSON.stringify({ mensagem: mensagem.trim() }),
      });
      setMensagem("");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao enviar comentário.");
    } finally {
      setEnviandoComentario(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs}>
        <button
          type="button"
          className={`${styles.tabBtn} ${aba === "anexos" ? styles.tabAtiva : ""}`}
          onClick={() => setAba("anexos")}
        >
          Anexos {anexos.length > 0 && <span className={styles.count}>{anexos.length}</span>}
        </button>
        <button
          type="button"
          className={`${styles.tabBtn} ${aba === "comentarios" ? styles.tabAtiva : ""}`}
          onClick={() => setAba("comentarios")}
        >
          Comentários {comentarios.length > 0 && <span className={styles.count}>{comentarios.length}</span>}
        </button>
      </div>

      {erro && <p className={styles.erro}>{erro}</p>}

      {aba === "anexos" && (
        <div>
          <div
            className={`${styles.dropzone} ${arrastando ? styles.dropzoneAtiva : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setArrastando(true);
            }}
            onDragLeave={() => setArrastando(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastando(false);
              if (e.dataTransfer.files.length > 0) enviarArquivos(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) enviarArquivos(e.target.files);
                e.target.value = "";
              }}
            />
            {enviandoArquivo ? "Enviando..." : "Arraste um arquivo aqui ou clique para selecionar (foto, PDF, ART — até 10 MB)"}
          </div>

          {carregando ? (
            <p className={styles.vazio}>Carregando…</p>
          ) : anexos.length === 0 ? (
            <p className={styles.vazio}>Nenhum anexo ainda.</p>
          ) : (
            <ul className={styles.listaAnexos}>
              {anexos.map((a) => (
                <li key={a.id} className={styles.itemAnexo}>
                  {a.tipoMime.startsWith("image/") ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className={styles.anexoPreviewLink}>
                      <img src={a.url} alt={a.nomeArquivo} className={styles.anexoThumb} />
                    </a>
                  ) : (
                    <a href={a.url} target="_blank" rel="noreferrer" className={styles.anexoIcone}>
                      PDF
                    </a>
                  )}
                  <div className={styles.anexoInfo}>
                    <a href={a.url} target="_blank" rel="noreferrer" className={styles.anexoNome}>
                      {a.nomeArquivo}
                    </a>
                    <span className={styles.anexoMeta}>
                      {formatarTamanho(a.tamanhoBytes)} · enviado por {a.enviadoPorNome} em{" "}
                      {new Date(a.criadoEm).toLocaleString("pt-BR")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {aba === "comentarios" && (
        <div>
          {carregando ? (
            <p className={styles.vazio}>Carregando…</p>
          ) : comentarios.length === 0 ? (
            <p className={styles.vazio}>Nenhum comentário ainda.</p>
          ) : (
            <ul className={styles.thread}>
              {comentarios.map((c) => (
                <li key={c.id} className={styles.itemComentario}>
                  <div className={styles.comentarioHeader}>
                    <strong>{c.usuarioNome}</strong>
                    <span>{new Date(c.criadoEm).toLocaleString("pt-BR")}</span>
                  </div>
                  <p>{c.mensagem}</p>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.novoComentario}>
            <textarea
              rows={2}
              placeholder="Escreva um comentário..."
              value={mensagem}
              onChange={(e) => setMensagem(e.target.value)}
            />
            <button
              type="button"
              className={styles.btnEnviar}
              disabled={enviandoComentario || !mensagem.trim()}
              onClick={enviarComentario}
            >
              {enviandoComentario ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
