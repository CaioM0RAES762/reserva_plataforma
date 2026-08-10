"use client";

import styles from "./Paginacao.module.css";

export interface PaginacaoProps {
  total: number;
  pagina: number;
  porPagina: number;
  carregando?: boolean;
  onMudarPagina: (pagina: number) => void;
  rotuloItens?: string;
}

// Controle de paginação das listagens. Existe porque as rotas passaram a devolver uma
// janela de resultados (X-Total-Count no header) em vez da tabela inteira — sem este
// controle, o usuário simplesmente não veria os registros além da primeira página.
export function Paginacao({
  total,
  pagina,
  porPagina,
  carregando = false,
  onMudarPagina,
  rotuloItens = "registro(s)",
}: PaginacaoProps) {
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const primeiroDaPagina = total === 0 ? 0 : pagina * porPagina + 1;
  const ultimoDaPagina = Math.min((pagina + 1) * porPagina, total);

  // Uma única página não precisa de controle nenhum — o resumo já apareceria redundante
  // logo abaixo de uma tabela curta.
  if (total <= porPagina) {
    return total > 0 ? (
      <p className={styles.resumo} aria-live="polite">
        {total} {rotuloItens}
      </p>
    ) : null;
  }

  return (
    <nav className={styles.wrapper} aria-label="Paginação dos resultados">
      <p className={styles.resumo} aria-live="polite">
        Exibindo <strong>{primeiroDaPagina}</strong>–<strong>{ultimoDaPagina}</strong> de <strong>{total}</strong>{" "}
        {rotuloItens}
      </p>
      <div className={styles.controles}>
        <button
          type="button"
          className={styles.botao}
          onClick={() => onMudarPagina(pagina - 1)}
          disabled={pagina === 0 || carregando}
        >
          ← Anterior
        </button>
        <span className={styles.indicador}>
          Página {pagina + 1} de {totalPaginas}
        </span>
        <button
          type="button"
          className={styles.botao}
          onClick={() => onMudarPagina(pagina + 1)}
          disabled={pagina + 1 >= totalPaginas || carregando}
        >
          Próxima →
        </button>
      </div>
    </nav>
  );
}
