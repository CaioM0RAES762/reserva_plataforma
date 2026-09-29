"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "../app/(app)/plataformas/page.module.css";
import { indiceCiclico } from "../lib/galeria";

interface CarrosselPlataformaProps {
  /** Já na ordem de exibição — a primeira é a principal (capa). */
  urls: string[];
  nome: string;
  onAbrir: (indice: number) => void;
}

/* Imagem do card da Frota. 0 imagens: placeholder de sempre. 1 imagem: só a foto. 2–4:
 * setas discretas (cíclicas) e indicador "1 / 4". Clicar na foto abre o lightbox.
 * Imagem que falha ao carregar (link expirado, arquivo removido) cai para o placeholder. */
export function CarrosselPlataforma({ urls, nome, onAbrir }: CarrosselPlataformaProps) {
  const [indice, setIndice] = useState(0);
  const [falhas, setFalhas] = useState<Set<string>>(() => new Set());
  const total = urls.length;
  const atual = total > 0 ? urls[Math.min(indice, total - 1)] : null;

  if (!atual) {
    return <div className={styles.cardImagePlaceholder}>Sem imagem</div>;
  }

  return (
    <>
      {falhas.has(atual) ? (
        <div className={styles.cardImagePlaceholder}>Sem imagem</div>
      ) : (
        <button
          type="button"
          className={styles.cardImageBotao}
          onClick={() => onAbrir(Math.min(indice, total - 1))}
          aria-label={total > 1 ? `Ampliar imagem ${indice + 1} de ${total} de ${nome}` : `Ampliar imagem de ${nome}`}
        >
          <img
            key={atual}
            src={atual}
            alt=""
            className={styles.cardImage}
            // Frota com dezenas de plataformas: só baixa o que aparece na tela.
            loading="lazy"
            decoding="async"
            onError={() => setFalhas((anteriores) => new Set(anteriores).add(atual))}
          />
        </button>
      )}

      {total > 1 && (
        <>
          <button
            type="button"
            className={`${styles.cardSeta} ${styles.cardSetaAnterior}`}
            onClick={() => setIndice((i) => indiceCiclico(i, -1, total))}
            aria-label={`Imagem anterior de ${nome}`}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${styles.cardSeta} ${styles.cardSetaProxima}`}
            onClick={() => setIndice((i) => indiceCiclico(i, 1, total))}
            aria-label={`Próxima imagem de ${nome}`}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <span className={styles.cardIndicador} aria-hidden="true">
            {Math.min(indice, total - 1) + 1} / {total}
          </span>
        </>
      )}
    </>
  );
}
