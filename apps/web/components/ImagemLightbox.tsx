"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import styles from "./ImagemLightbox.module.css";
import { useTravarScrollDaPagina } from "../lib/useTravarScrollDaPagina";
import { indiceCiclico } from "../lib/galeria";

interface ImagemLightboxProps {
  imagens: Array<{ url: string }>;
  indiceInicial: number;
  titulo: string;
  onClose: () => void;
}

/* Imagem ampliada, sem sair da página. Fecha com X, Esc ou clique fora da foto; ‹ › e as
 * setas do teclado navegam (cíclico); no toque, deslizar para os lados também navega.
 *
 * Teclado escutado no WINDOW em captura: o lightbox pode abrir por cima de outro modal (o
 * formulário da plataforma), cujo handler fica no document — assim o Esc fecha só a foto,
 * não o formulário inteiro. */
export function ImagemLightbox({ imagens, indiceInicial, titulo, onClose }: ImagemLightboxProps) {
  const [indice, setIndice] = useState(() => Math.min(Math.max(indiceInicial, 0), imagens.length - 1));
  const refDialogo = useRef<HTMLDivElement>(null);
  const refFechar = useRef<HTMLButtonElement>(null);
  const toqueInicioX = useRef<number | null>(null);
  const aoFecharRef = useRef(onClose);
  aoFecharRef.current = onClose;
  const total = imagens.length;

  useTravarScrollDaPagina(true);

  useEffect(() => {
    const origem = document.activeElement as HTMLElement | null;
    refFechar.current?.focus();

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") {
        evento.preventDefault();
        evento.stopImmediatePropagation();
        aoFecharRef.current();
      } else if (evento.key === "ArrowRight" || evento.key === "ArrowLeft") {
        evento.preventDefault();
        evento.stopImmediatePropagation();
        setIndice((i) => indiceCiclico(i, evento.key === "ArrowRight" ? 1 : -1, total));
      } else if (evento.key === "Tab") {
        // Foco preso no lightbox (X e setas).
        const focaveis = refDialogo.current?.querySelectorAll<HTMLElement>("button");
        evento.stopImmediatePropagation();
        if (!focaveis || focaveis.length === 0) return;
        const primeiro = focaveis[0];
        const ultimo = focaveis[focaveis.length - 1];
        if (evento.shiftKey && document.activeElement === primeiro) {
          evento.preventDefault();
          ultimo.focus();
        } else if (!evento.shiftKey && document.activeElement === ultimo) {
          evento.preventDefault();
          primeiro.focus();
        }
      }
    }
    window.addEventListener("keydown", aoTeclar, true);
    return () => {
      window.removeEventListener("keydown", aoTeclar, true);
      origem?.focus?.();
    };
  }, [total]);

  if (total === 0) return null;
  const atual = imagens[indice];

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        toqueInicioX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const inicio = toqueInicioX.current;
        toqueInicioX.current = null;
        const fim = e.changedTouches[0]?.clientX;
        if (inicio === null || fim === undefined || total < 2) return;
        const delta = fim - inicio;
        if (Math.abs(delta) > 48) setIndice((i) => indiceCiclico(i, delta < 0 ? 1 : -1, total));
      }}
    >
      <div
        ref={refDialogo}
        className={styles.dialogo}
        role="dialog"
        aria-modal="true"
        aria-label={`${titulo} — imagem ${indice + 1} de ${total}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <button ref={refFechar} type="button" className={styles.fechar} onClick={onClose} aria-label="Fechar imagem">
          <X size={20} aria-hidden="true" />
        </button>

        <img key={atual.url} src={atual.url} alt={`${titulo} — imagem ${indice + 1} de ${total}`} className={styles.imagem} />

        {total > 1 && (
          <>
            <button
              type="button"
              className={`${styles.seta} ${styles.setaAnterior}`}
              onClick={() => setIndice((i) => indiceCiclico(i, -1, total))}
              aria-label="Imagem anterior"
            >
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${styles.seta} ${styles.setaProxima}`}
              onClick={() => setIndice((i) => indiceCiclico(i, 1, total))}
              aria-label="Próxima imagem"
            >
              <ChevronRight size={24} aria-hidden="true" />
            </button>
            <span className={styles.indicador} aria-live="polite">
              {indice + 1} / {total}
            </span>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
