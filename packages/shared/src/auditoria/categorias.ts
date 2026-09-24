/* Índices derivados do catálogo — usados pelo filtro de categoria da tela e pelo WHERE
 * da API.
 *
 * Por que a expansão categoria → lista de ações acontece no servidor: a listagem é
 * paginada no banco (OFFSET/FETCH). Filtrar categoria no cliente encolheria só a página
 * atual e deixaria a contagem total mentindo — "184 eventos" com três linhas na tela.
 * Como o catálogo vive em `shared`, a API importa este mapa e o transforma num
 * `la.acao IN (...)`, sem duplicar a classificação em lugar nenhum.
 */

import { EVENTOS_AUDITORIA, type CategoriaAuditoria, type RelevanciaAuditoria } from "./catalogo.js";

/** Categoria → códigos de ação que pertencem a ela. Construído uma vez, na carga. */
export const ACOES_POR_CATEGORIA: Record<string, string[]> = (() => {
  const indice: Record<string, string[]> = {};
  for (const [acao, meta] of Object.entries(EVENTOS_AUDITORIA)) {
    (indice[meta.categoria] ??= []).push(acao);
  }
  return indice;
})();

/** Relevância → códigos de ação. Alimenta o filtro "Importância". */
export const ACOES_POR_RELEVANCIA: Record<string, string[]> = (() => {
  const indice: Record<string, string[]> = {};
  for (const [acao, meta] of Object.entries(EVENTOS_AUDITORIA)) {
    (indice[meta.relevancia] ??= []).push(acao);
  }
  return indice;
})();

/**
 * Opções do <select> de evento, agrupadas por categoria e ordenadas pelo rótulo humano —
 * o valor continua sendo o código interno (`criar_reserva`), que é o que a API filtra.
 */
export function opcoesDeEvento(): Array<{ categoria: CategoriaAuditoria; eventos: Array<{ valor: string; rotulo: string }> }> {
  const porCategoria = new Map<CategoriaAuditoria, Array<{ valor: string; rotulo: string }>>();
  for (const [acao, meta] of Object.entries(EVENTOS_AUDITORIA)) {
    const lista = porCategoria.get(meta.categoria) ?? [];
    lista.push({ valor: acao, rotulo: meta.titulo });
    porCategoria.set(meta.categoria, lista);
  }
  return [...porCategoria.entries()]
    .map(([categoria, eventos]) => ({
      categoria,
      eventos: eventos.sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR")),
    }))
    .sort((a, b) => a.categoria.localeCompare(b.categoria, "pt-BR"));
}

/** Nomes de categoria aceitos pela API — evita montar IN(...) com entrada arbitrária. */
export function categoriaValida(valor: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACOES_POR_CATEGORIA, valor);
}

export function relevanciaValida(valor: string): valor is RelevanciaAuditoria {
  return valor === "informativa" || valor === "normal" || valor === "importante";
}
