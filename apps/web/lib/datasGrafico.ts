/* Rótulos de data dos gráficos de Relatórios. A API entrega o dia como "YYYY-MM-DD" (string
 * de calendário, já no fuso de Brasília) — a formatação é puramente textual: `new Date()`
 * interpretaria a string como meia-noite UTC e, em UTC-3, mostraria o dia ANTERIOR. */
const ISO_DIA = /^(\d{4})-(\d{2})-(\d{2})/;

/** "2026-09-24" → "24-09" (eixo X). Valor fora do formato volta como veio. */
export function formatarDiaMesEixo(valor: unknown): string {
  const texto = String(valor ?? "");
  const m = ISO_DIA.exec(texto);
  return m ? `${m[3]}-${m[2]}` : texto;
}

/** "2026-09-24" → "24/09/2026" (tooltip). */
export function formatarDataCompletaGrafico(valor: unknown): string {
  const texto = String(valor ?? "");
  const m = ISO_DIA.exec(texto);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : texto;
}
