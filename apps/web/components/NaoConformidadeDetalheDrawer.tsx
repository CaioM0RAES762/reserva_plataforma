"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, TriangleAlert, X } from "lucide-react";
import { STATUS_NAO_CONFORMIDADE, type NaoConformidadePublica, type StatusNaoConformidade } from "@plataformares/shared";
import styles from "./NaoConformidadeDetalheDrawer.module.css";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { apiFetch, mensagemDeErro } from "../lib/api";

const STATUS_LABELS: Record<StatusNaoConformidade, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  resolvida: "Resolvida",
};

function formatarDataExtensa(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }) +
    " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export interface NaoConformidadeDetalheDrawerProps {
  item: NaoConformidadePublica;
  /** Já vem calculado (admin, ou gestor do mesmo setor) — o drawer só desabilita o controle. */
  podeAlterarStatus: boolean;
  onClose: () => void;
  onStatusAlterado: (atualizada: NaoConformidadePublica) => void;
}

/**
 * Detalhe de uma não conformidade, em drawer lateral (mesmo padrão de
 * AuditoriaDetalheDrawer). A origem continua sendo o comentário na reserva — "Ver reserva"
 * leva para lá; nada do conteúdo (descrição/imagens) é duplicado, só exibido.
 */
export function NaoConformidadeDetalheDrawer({
  item,
  podeAlterarStatus,
  onClose,
  onStatusAlterado,
}: NaoConformidadeDetalheDrawerProps) {
  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "nc-detalhe");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function alterarStatus(novoStatus: StatusNaoConformidade) {
    if (novoStatus === item.status) return;
    setSalvando(true);
    setErro(null);
    try {
      const atualizada = await apiFetch<NaoConformidadePublica>(`/api/v1/nao-conformidades/${item.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: novoStatus }),
      });
      onStatusAlterado(atualizada);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao atualizar o status."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={aoClicarNoOverlay}>
      <div className={styles.drawer} ref={refDialogo} {...propsDialogo}>
        <header className={styles.cabecalho}>
          <div className={styles.cabecalhoTexto}>
            <span className={styles.eyebrow}>
              <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
              Não conformidade
            </span>
            <h2 id={idTitulo} className={styles.titulo}>
              {item.plataformaNome}
            </h2>
            <p className={styles.dataExtensa}>{formatarDataExtensa(item.criadoEm)}</p>
          </div>
          <button type="button" className={styles.fechar} onClick={onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.corpo}>
          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Local</h3>
            <p className={styles.valorForte}>{item.plataformaNome}</p>
            <p className={styles.valorFraco}>{item.setorNome}</p>
          </section>

          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Autor</h3>
            <p className={styles.valorForte}>{item.autorNome}</p>
          </section>

          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Descrição</h3>
            <p className={styles.descricaoCompleta}>{item.descricao || "Sem descrição — registrada só com imagem."}</p>
          </section>

          {item.imagens.length > 0 && (
            <section className={styles.bloco}>
              <h3 className={styles.blocoTitulo}>Imagens</h3>
              <div className={styles.galeria}>
                {item.imagens.map((imagem) => (
                  <a key={imagem.id} href={imagem.url} target="_blank" rel="noreferrer" className={styles.imagemLink}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imagem.url} alt={imagem.nomeArquivo} loading="lazy" />
                  </a>
                ))}
              </div>
            </section>
          )}

          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Status</h3>
            {podeAlterarStatus ? (
              <select
                className={styles.selectStatus}
                value={item.status}
                disabled={salvando}
                onChange={(e) => alterarStatus(e.target.value as StatusNaoConformidade)}
                aria-label="Alterar status da não conformidade"
              >
                {STATUS_NAO_CONFORMIDADE.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            ) : (
              <p className={styles.valorForte}>{STATUS_LABELS[item.status]}</p>
            )}
            {item.resolvidoEm && (
              <p className={styles.valorFraco}>Resolvida em {formatarDataExtensa(item.resolvidoEm)}</p>
            )}
            {erro && (
              <p className={styles.erro} role="alert">
                {erro}
              </p>
            )}
          </section>

          <Link href={`/reservas?reserva=${item.reservaId}`} className={styles.verReserva}>
            Ver reserva
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
