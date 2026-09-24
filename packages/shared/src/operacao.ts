// Regras puras de operação (sem banco, sem relógio do sistema) compartilhadas entre API e
// frontend: horímetro por uso real e janela dinâmica da "Agenda em curso".

function paraMinutos(hora: string): number {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

export interface DadosUsoReserva {
  horaInicio: string;
  horaFim: string;
  horaInicioReal: string | null;
  horaFimReal: string | null;
  inicioAutomatico: boolean;
}

/**
 * Minutos efetivamente utilizados por uma reserva — o incremento do horímetro.
 *
 * - Início: o registrado (`horaInicioReal`). Sem registro, só conta se a reserva era de
 *   início automático (o sistema garantiu o início no horário agendado — caso do servidor
 *   fora do ar durante a janela). Início manual nunca registrado = nunca houve uso → 0.
 * - Fim: o registrado (`horaFimReal`). Sem fim registrado não há uso encerrado → 0.
 * - Transições automáticas gravam o horário AGENDADO (ver reservaTransicao.service), então
 *   início e fim automáticos resultam exatamente na duração agendada; manuais usam o real.
 * - Fim "antes" do início só acontece quando o encerramento manual passou da meia-noite:
 *   soma-se um dia em vez de descartar o uso.
 */
export function calcularMinutosDeUso(dados: DadosUsoReserva): number {
  const inicio = dados.horaInicioReal ?? (dados.inicioAutomatico ? dados.horaInicio : null);
  if (!inicio || !dados.horaFimReal) return 0;
  let minutos = paraMinutos(dados.horaFimReal) - paraMinutos(inicio);
  if (minutos < 0) minutos += 24 * 60;
  return Math.max(0, minutos);
}

/** Horímetro atual em horas = baseline cadastrado + uso contabilizado pelo sistema. */
export function horimetroAtualHoras(baselineHoras: number | null, usoMinutos: number): number | null {
  if (baselineHoras === null && usoMinutos === 0) return null;
  return Math.round(((baselineHoras ?? 0) + usoMinutos / 60) * 100) / 100;
}

/** "461h 35min" / "462h" — formato de exibição do horímetro. */
export function formatarHorimetro(horas: number | null): string {
  if (horas === null) return "—";
  const totalMin = Math.round(horas * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}min`;
}

export interface JanelaAgendaEmCurso {
  inicioHora: number;
  fimHora: number;
}

/**
 * Janela horária da "Agenda em curso" (Central de Operações), derivada do conteúdo do dia
 * em vez de uma faixa fixa:
 *   início = menor entre início do expediente, primeira reserva e (agora − folga)
 *   fim    = maior entre fim do expediente, fim da última reserva e (agora + folga)
 * arredondados para horas cheias e limitados ao dia [00:00, 24:00].
 */
export function calcularJanelaAgendaEmCurso(params: {
  agoraMin: number;
  intervalos: Array<{ horaInicio: string; horaFim: string }>;
  expediente?: { inicio: string; fim: string } | null;
  folgaMin?: number;
}): JanelaAgendaEmCurso {
  const folga = params.folgaMin ?? 60;
  const inicios = params.intervalos.map((i) => paraMinutos(i.horaInicio));
  const fins = params.intervalos.map((i) => paraMinutos(i.horaFim));
  if (params.expediente) {
    inicios.push(paraMinutos(params.expediente.inicio));
    fins.push(paraMinutos(params.expediente.fim));
  }
  inicios.push(params.agoraMin - folga);
  fins.push(params.agoraMin + folga);

  const limitar = (min: number) => Math.min(24 * 60, Math.max(0, min));
  let inicioHora = Math.floor(limitar(Math.min(...inicios)) / 60);
  let fimHora = Math.ceil(limitar(Math.max(...fins)) / 60);
  if (fimHora <= inicioHora) {
    // Janela degenerada (ex.: 23:59 com folga cortada no limite do dia).
    if (fimHora < 24) fimHora = inicioHora + 1;
    else inicioHora = fimHora - 1;
  }
  return { inicioHora, fimHora };
}
