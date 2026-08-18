// Correção da Agenda em curso: reservas com horários sobrepostos disputavam a mesma
// linha da timeline e ficavam empilhadas visualmente umas sobre as outras. Este algoritmo
// (greedy interval partitioning — clássico, O(n log n) dominado pelo sort) distribui cada
// reserva na primeira "lane" livre (sem sobreposição); quando todas as lanes existentes
// estão ocupadas naquele horário, abre uma nova. Puro e sem dependência de DOM/React —
// vive em shared para poder ser testado pela suíte do apps/api (apps/web não tem test
// runner próprio ainda, mesmo padrão já usado por datetime.ts).

export interface IntervaloMinutos {
  inicioMinutos: number;
  fimMinutos: number;
}

export interface ItemComLane<T> {
  item: T;
  lane: number;
}

export function calcularLanes<T>(itens: T[], obterIntervalo: (item: T) => IntervaloMinutos): ItemComLane<T>[] {
  const ordenados = [...itens].sort((a, b) => obterIntervalo(a).inicioMinutos - obterIntervalo(b).inicioMinutos);
  // fimPorLane[i] = horário (em minutos) em que a lane i fica livre de novo.
  const fimPorLane: number[] = [];
  const resultado: ItemComLane<T>[] = [];

  for (const item of ordenados) {
    const { inicioMinutos, fimMinutos } = obterIntervalo(item);
    let lane = fimPorLane.findIndex((fimDaLane) => fimDaLane <= inicioMinutos);
    if (lane === -1) {
      lane = fimPorLane.length;
      fimPorLane.push(fimMinutos);
    } else {
      fimPorLane[lane] = fimMinutos;
    }
    resultado.push({ item, lane });
  }

  return resultado;
}

export function contarLanes(itensComLane: ItemComLane<unknown>[]): number {
  if (itensComLane.length === 0) return 0;
  return Math.max(...itensComLane.map((i) => i.lane)) + 1;
}
