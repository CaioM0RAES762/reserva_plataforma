"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import styles from "./FiltrosAvancados.module.css";

export interface FiltrosAvancadosProps {
  /** Controles sempre visíveis — na prática, busca e os chips de status. */
  children: ReactNode;
  /** Controles secundários, revelados só quando o usuário pede. */
  avancados: ReactNode;
  /** Quantos filtros secundários estão preenchidos — vira o contador do botão. */
  ativos?: number;
  /** Texto curto de resultado ("128 reservas"), à direita da barra. */
  contagem?: string;
  onLimpar?: () => void;
}

/**
 * Barra de filtros em dois níveis.
 *
 * Nível 1 (`children`) fica sempre na tela porque cobre a quase totalidade do uso: buscar
 * um nome e alternar o status. Nível 2 (`avancados`) — período, setor, plataforma — só
 * aparece sob demanda, num painel em grid horizontal, e o botão carrega um contador
 * enquanto houver algo aplicado ali dentro, para que um filtro escondido nunca explique
 * silenciosamente uma tabela vazia.
 */
export function FiltrosAvancados({ children, avancados, ativos = 0, contagem, onLimpar }: FiltrosAvancadosProps) {
  const [aberto, setAberto] = useState(false);
  const idPainel = useId();

  return (
    <>
      <div className={styles.barra}>
        {children}
        <span className={styles.espaco} />
        {contagem && (
          // aria-live: a contagem muda sozinha conforme os filtros; sem isso, quem usa
          // leitor de tela não percebe a lista encolhendo.
          <span className={styles.contagem} aria-live="polite">
            {contagem}
          </span>
        )}
        <button
          type="button"
          className={`${styles.botao} ${aberto ? styles.botaoAberto : ""}`}
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
          aria-controls={idPainel}
        >
          <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          Mais filtros
          {ativos > 0 && <span className={styles.contador}>{ativos}</span>}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {aberto && (
        <div className={styles.painel} id={idPainel}>
          {avancados}
          {onLimpar && ativos > 0 && (
            <button type="button" className={styles.limpar} onClick={onLimpar}>
              Limpar filtros
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Campo rotulado do painel — evita repetir a mesma dupla label+controle em cada tela. */
export function CampoFiltro({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className={styles.campo}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
