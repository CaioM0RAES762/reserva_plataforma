// Período de uma reserva: de (data, horaInicio) até (dataFim, horaFim), no horário civil de
// Brasília (o referencial de Reserva.data/hora_inicio/hora_fim). Reserva de um dia só tem
// dataFim = data; reserva de vários dias atravessa a meia-noite (migration 0029).
//
// Regras puras (sem banco, sem relógio) compartilhadas por API e frontend — validação do
// período, duração e texto de exibição saem daqui para nunca divergirem entre as camadas.

export interface PeriodoReserva {
  /** "YYYY-MM-DD" */
  data: string;
  /** "YYYY-MM-DD" — igual a `data` numa reserva de um dia. */
  dataFim: string;
  /** "HH:mm" */
  horaInicio: string;
  /** "HH:mm" */
  horaFim: string;
}

const MS_POR_MINUTO = 60_000;

/**
 * Minutos desde a época de uma data+hora CIVIL (sem fuso). Serve só para comparar e subtrair
 * instantes do mesmo referencial — nunca para comparar com `Date.now()` (para isso, use
 * combinarDataHoraBrasilia).
 */
export function minutosCivis(data: string, hora: string): number {
  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  return Date.UTC(ano, mes - 1, dia, h, m) / MS_POR_MINUTO;
}

export function inicioCivilMin(periodo: Pick<PeriodoReserva, "data" | "horaInicio">): number {
  return minutosCivis(periodo.data, periodo.horaInicio);
}

export function fimCivilMin(periodo: Pick<PeriodoReserva, "dataFim" | "horaFim">): number {
  return minutosCivis(periodo.dataFim, periodo.horaFim);
}

/** Duração em minutos (pode passar de 24h). Negativa/zero = período inválido. */
export function duracaoPeriodoMinutos(periodo: PeriodoReserva): number {
  return fimCivilMin(periodo) - inicioCivilMin(periodo);
}

/** O fim vem depois do início (mesma regra do CHECK CK_Reserva_periodo). */
export function periodoValido(periodo: PeriodoReserva): boolean {
  return duracaoPeriodoMinutos(periodo) > 0;
}

export function periodoDeVariosDias(periodo: Pick<PeriodoReserva, "data" | "dataFim">): boolean {
  return periodo.dataFim !== periodo.data;
}

/** RN-RES-02 (adjacência exata NÃO é conflito): [inicio, fim) de A e B se cruzam. */
export function periodosSeSobrepoem(a: PeriodoReserva, b: PeriodoReserva): boolean {
  return inicioCivilMin(a) < fimCivilMin(b) && fimCivilMin(a) > inicioCivilMin(b);
}

/** Desloca uma data civil "YYYY-MM-DD" em `dias` (negativo volta). */
export function somarDiasCivis(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

/** Dias corridos entre duas datas civis (b − a). */
export function diasEntreDatas(a: string, b: string): number {
  return Math.round((minutosCivis(b, "00:00") - minutosCivis(a, "00:00")) / (24 * 60));
}

/**
 * Recorte do período no dia civil `dia`, em minutos 0..1440 (fim exclusivo — 1440 = a reserva
 * continua depois da meia-noite). `null` = o período não toca o dia. É o que a grade do
 * Calendário e o seletor de horário desenham para uma reserva de vários dias.
 */
export function recortarPeriodoNoDia(
  periodo: PeriodoReserva,
  dia: string
): { inicioMin: number; fimMin: number } | null {
  const inicioDia = minutosCivis(dia, "00:00");
  const inicioMin = Math.max(0, inicioCivilMin(periodo) - inicioDia);
  const fimMin = Math.min(24 * 60, fimCivilMin(periodo) - inicioDia);
  return fimMin > inicioMin ? { inicioMin, fimMin } : null;
}

function dataBr(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

/** "02/10/2026 · 08:00–17:00" ou "02/10/2026 08:00 → 09/10/2026 17:00". */
export function formatarPeriodoReserva(periodo: PeriodoReserva): string {
  if (!periodoDeVariosDias(periodo)) {
    return `${dataBr(periodo.data)} · ${periodo.horaInicio}–${periodo.horaFim}`;
  }
  return `${dataBr(periodo.data)} ${periodo.horaInicio} → ${dataBr(periodo.dataFim)} ${periodo.horaFim}`;
}

/** Só o horário, para quem já mostra a data ao lado: "08:00–17:00" ou "08:00 → 09/10 17:00". */
export function formatarHorarioReserva(periodo: PeriodoReserva): string {
  if (!periodoDeVariosDias(periodo)) return `${periodo.horaInicio}–${periodo.horaFim}`;
  const [, mes, dia] = periodo.dataFim.split("-");
  return `${periodo.horaInicio} → ${dia}/${mes} ${periodo.horaFim}`;
}

/** "3 dias e 4h" / "9h" / "1h30" — duração legível de um período. */
export function formatarDuracaoPeriodo(minutos: number): string {
  if (minutos <= 0) return "—";
  const dias = Math.floor(minutos / (24 * 60));
  const resto = minutos % (24 * 60);
  const horas = Math.floor(resto / 60);
  const mins = resto % 60;
  const parteHoras = horas || mins ? `${horas}h${mins ? String(mins).padStart(2, "0") : ""}` : "";
  if (!dias) return parteHoras;
  const parteDias = `${dias} dia${dias > 1 ? "s" : ""}`;
  return parteHoras ? `${parteDias} e ${parteHoras}` : parteDias;
}
