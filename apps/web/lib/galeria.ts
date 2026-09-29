/* Regras puras da galeria de imagens da plataforma (card, lightbox e formulário). */

export const LIMITE_IMAGENS = 4;
export const TAMANHO_MAX_IMAGEM_BYTES = 10 * 1024 * 1024;
export const TIPOS_IMAGEM_ACEITOS = ["image/jpeg", "image/png", "image/webp"] as const;
export const MENSAGEM_LIMITE_IMAGENS = "Limite de 4 imagens atingido.";

/** Navegação cíclica: da última volta para a primeira e vice-versa. */
export function indiceCiclico(atual: number, passo: number, total: number): number {
  if (total <= 0) return 0;
  return (((atual + passo) % total) + total) % total;
}

/** Leva o item para a primeira posição (= principal) mantendo a ordem relativa dos demais —
 *  a mesma regra que a API aplica em PATCH /imagens/:id/principal. */
export function moverParaPrincipal<T>(itens: T[], indice: number): T[] {
  if (indice <= 0 || indice >= itens.length) return itens;
  return [itens[indice], ...itens.slice(0, indice), ...itens.slice(indice + 1)];
}

/** Separa os arquivos escolhidos entre os que cabem nas vagas restantes e os recusados
 *  (tipo/tamanho), sem nunca passar do limite. */
export function triarArquivos<A extends { type: string; size: number; name: string }>(
  arquivos: A[],
  jaNaGaleria: number
): { aceitos: A[]; recusados: Array<{ nome: string; motivo: string }>; excedeuLimite: boolean } {
  const vagas = Math.max(0, LIMITE_IMAGENS - jaNaGaleria);
  const aceitos: A[] = [];
  const recusados: Array<{ nome: string; motivo: string }> = [];
  let excedeuLimite = false;
  for (const arquivo of arquivos) {
    if (!(TIPOS_IMAGEM_ACEITOS as readonly string[]).includes(arquivo.type)) {
      recusados.push({ nome: arquivo.name, motivo: "use JPG, PNG ou WEBP" });
    } else if (arquivo.size > TAMANHO_MAX_IMAGEM_BYTES) {
      recusados.push({ nome: arquivo.name, motivo: "maior que 10 MB" });
    } else if (aceitos.length >= vagas) {
      excedeuLimite = true;
    } else {
      aceitos.push(arquivo);
    }
  }
  return { aceitos, recusados, excedeuLimite };
}
