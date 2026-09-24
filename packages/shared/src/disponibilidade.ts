// Aritmética pura de horários/janelas — compartilhada por API (cálculo de disponibilidade,
// próximo horário livre), Calendário (grade proporcional) e "Nova Reserva" (horários livres,
// atalhos de duração). Sem acesso a banco/relógio/DOM: tudo determinístico e testável.
//
// Convenção: todo horário é "minutos desde 00:00" (0..1440). A reserva só aceita HH:mm até
// 23:59 (ver HORA_REGEX em schemas/reserva.ts), então o fim máximo de uma reserva é 1439 —
// 1440 só aparece como limite exclusivo de um dia inteiro (bloqueio que vira a meia-noite,
// grade do calendário).

export const MINUTOS_DIA = 24 * 60;
/** Último minuto que um HH:mm consegue expressar (23:59) — teto de `horaFim` de uma reserva. */
export const ULTIMO_MINUTO_RESERVAVEL = MINUTOS_DIA - 1;
/** Granularidade da escolha de horário na Nova Reserva e do clique no Calendário. */
export const PASSO_MINUTOS_PADRAO = 30;
/** Atalhos de duração oferecidos depois de escolher o início (só os que couberem). */
export const ATALHOS_DURACAO_MINUTOS = [60, 120, 240] as const;

export interface FaixaMinutos {
  inicioMin: number;
  fimMin: number;
}

export function horaParaMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 0 → "00:00", 1439 → "23:59", 1440 → "24:00" (só para rótulo de grade, nunca para payload). */
export function minutosParaHora(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Ordena por início e funde sobreposições/adjacências. Não muta a entrada. */
export function mesclarIntervalos(intervalos: FaixaMinutos[]): FaixaMinutos[] {
  const ordenados = intervalos
    .filter((i) => i.fimMin > i.inicioMin)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.inicioMin - b.inicioMin || a.fimMin - b.fimMin);
  const resultado: FaixaMinutos[] = [];
  for (const atual of ordenados) {
    const ultimo = resultado[resultado.length - 1];
    if (ultimo && atual.inicioMin <= ultimo.fimMin) {
      ultimo.fimMin = Math.max(ultimo.fimMin, atual.fimMin);
    } else {
      resultado.push({ inicioMin: atual.inicioMin, fimMin: atual.fimMin });
    }
  }
  return resultado;
}

/**
 * Janela visível da grade do Calendário a partir do expediente configurado.
 *
 * `fim` é EXCLUSIVO no arredondamento para a hora seguinte: expediente 00:00–23:59 vira as
 * linhas 00..23 (grade termina em 24:00, não em 23:00 — senão a última hora sumiria);
 * 06:00–18:00 vira 06..17 (termina em 18:00); 06:00–18:30 vira 06..18 (termina em 19:00).
 */
export function calcularJanelaGrade(
  horarioInicio: string,
  horarioFim: string
): { inicioHora: number; fimHora: number; horas: number[]; inicioMin: number; fimMin: number } {
  const inicioMinExpediente = Math.max(0, horaParaMinutos(horarioInicio));
  const fimMinExpediente = Math.min(MINUTOS_DIA, horaParaMinutos(horarioFim));
  const inicioHora = Math.floor(inicioMinExpediente / 60);
  let fimHora = Math.ceil(fimMinExpediente / 60);
  if (fimHora <= inicioHora) fimHora = Math.min(24, inicioHora + 1);
  return {
    inicioHora,
    fimHora,
    horas: Array.from({ length: fimHora - inicioHora }, (_, i) => inicioHora + i),
    inicioMin: inicioHora * 60,
    fimMin: fimHora * 60,
  };
}

/**
 * Trechos livres dentro de `janela` depois de subtrair `ocupados`.
 * `apartirDeMin` (ex.: agora + antecedência mínima) corta tudo que começaria antes dele.
 */
export function calcularIntervalosLivres(
  ocupados: FaixaMinutos[],
  janela: FaixaMinutos,
  apartirDeMin?: number
): FaixaMinutos[] {
  const limiteInicio = Math.max(janela.inicioMin, apartirDeMin ?? janela.inicioMin);
  const livres: FaixaMinutos[] = [];
  let cursor = limiteInicio;
  for (const ocupado of mesclarIntervalos(ocupados)) {
    if (ocupado.fimMin <= cursor) continue;
    if (ocupado.inicioMin >= janela.fimMin) break;
    if (ocupado.inicioMin > cursor) {
      livres.push({ inicioMin: cursor, fimMin: Math.min(ocupado.inicioMin, janela.fimMin) });
    }
    cursor = Math.max(cursor, ocupado.fimMin);
  }
  if (cursor < janela.fimMin) livres.push({ inicioMin: cursor, fimMin: janela.fimMin });
  return livres.filter((l) => l.fimMin > l.inicioMin);
}

/** Início de cada slot de `passoMin` que ainda comporta pelo menos `duracaoMinimaMin`. */
export function inicioDeSlotsLivres(
  livres: FaixaMinutos[],
  passoMin: number = PASSO_MINUTOS_PADRAO,
  duracaoMinimaMin: number = PASSO_MINUTOS_PADRAO
): number[] {
  const inicios: number[] = [];
  for (const livre of livres) {
    let candidato = Math.ceil(livre.inicioMin / passoMin) * passoMin;
    // Um trecho livre que começa fora da grade (ex.: 13:10) ainda pode ser reservado a
    // partir do próprio início — só oferecemos o início exato quando ele não é múltiplo.
    if (candidato > livre.inicioMin && livre.inicioMin % passoMin !== 0) {
      if (livre.fimMin - livre.inicioMin >= duracaoMinimaMin) inicios.push(livre.inicioMin);
    }
    for (; candidato + duracaoMinimaMin <= livre.fimMin; candidato += passoMin) {
      inicios.push(candidato);
    }
  }
  return [...new Set(inicios)].sort((a, b) => a - b);
}

/**
 * Fim máximo possível para uma reserva que começa em `inicioMin`: o menor entre o fim do
 * trecho livre que contém o início, o teto de duração e o último minuto reservável.
 * `null` = `inicioMin` não está dentro de nenhum trecho livre.
 */
export function fimMaximoPossivel(
  inicioMin: number,
  livres: FaixaMinutos[],
  duracaoMaximaMin: number
): number | null {
  const trecho = livres.find((l) => inicioMin >= l.inicioMin && inicioMin < l.fimMin);
  if (!trecho) return null;
  return Math.min(trecho.fimMin, inicioMin + duracaoMaximaMin, ULTIMO_MINUTO_RESERVAVEL);
}

/** Atalhos de duração que CABEM (nunca passam de próxima reserva/bloqueio/expediente/duração máxima). */
export function duracoesRapidasPermitidas(
  inicioMin: number,
  livres: FaixaMinutos[],
  duracaoMaximaMin: number,
  atalhos: readonly number[] = ATALHOS_DURACAO_MINUTOS
): number[] {
  const fimMax = fimMaximoPossivel(inicioMin, livres, duracaoMaximaMin);
  if (fimMax === null) return [];
  return atalhos.filter((duracao) => inicioMin + duracao <= fimMax);
}

/** `true` se [inicioMin, fimMin) cabe inteiro dentro de algum trecho livre. */
export function intervaloCabeNosLivres(intervalo: FaixaMinutos, livres: FaixaMinutos[]): boolean {
  return livres.some((l) => intervalo.inicioMin >= l.inicioMin && intervalo.fimMin <= l.fimMin);
}
