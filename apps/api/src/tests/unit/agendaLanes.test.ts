import { describe, expect, it } from "vitest";
import { calcularLanes, contarLanes } from "@plataformares/shared";

interface ReservaTeste {
  id: string;
  inicio: number;
  fim: number;
}

function r(id: string, inicio: number, fim: number): ReservaTeste {
  return { id, inicio, fim };
}

const obterIntervalo = (item: ReservaTeste) => ({ inicioMinutos: item.inicio, fimMinutos: item.fim });

describe("calcularLanes — Agenda em curso (sem sobreposição visual)", () => {
  it("reservas sem sobreposição ficam todas na lane 0", () => {
    const itens = [r("a", 7 * 60, 8 * 60), r("b", 8 * 60, 9 * 60), r("c", 9 * 60, 10 * 60)];
    const resultado = calcularLanes(itens, obterIntervalo);
    expect(resultado.every((i) => i.lane === 0)).toBe(true);
    expect(contarLanes(resultado)).toBe(1);
  });

  it("duas reservas sobrepostas vão para lanes diferentes (Cenário D)", () => {
    // A: 11:00-13:00, B: 11:30-12:30 (sobreposição parcial)
    const itens = [r("A", 11 * 60, 13 * 60), r("B", 11 * 60 + 30, 12 * 60 + 30)];
    const resultado = calcularLanes(itens, obterIntervalo);
    const laneA = resultado.find((i) => i.item.id === "A")!.lane;
    const laneB = resultado.find((i) => i.item.id === "B")!.lane;
    expect(laneA).not.toBe(laneB);
    expect(contarLanes(resultado)).toBe(2);
  });

  it("três reservas simultâneas abrem três lanes (altura cresce com a demanda)", () => {
    const itens = [r("A", 10 * 60, 12 * 60), r("B", 10 * 60, 11 * 60), r("C", 10 * 60 + 30, 11 * 60 + 30)];
    const resultado = calcularLanes(itens, obterIntervalo);
    expect(contarLanes(resultado)).toBe(3);
    expect(new Set(resultado.map((i) => i.lane)).size).toBe(3);
  });

  it("mesmo horário exato (12:00-13:00 x2) -> lanes diferentes (Cenário E)", () => {
    const itens = [r("A", 12 * 60, 13 * 60), r("B", 12 * 60, 13 * 60)];
    const resultado = calcularLanes(itens, obterIntervalo);
    const laneA = resultado.find((i) => i.item.id === "A")!.lane;
    const laneB = resultado.find((i) => i.item.id === "B")!.lane;
    expect(laneA).not.toBe(laneB);
  });

  it("reserva que termina exatamente quando outra começa reaproveita a mesma lane (sem sobreposição real)", () => {
    // B começa às 9:00, exatamente quando A termina — não há colisão, mesma lane.
    const itens = [r("A", 8 * 60, 9 * 60), r("B", 9 * 60, 10 * 60)];
    const resultado = calcularLanes(itens, obterIntervalo);
    expect(resultado.find((i) => i.item.id === "A")!.lane).toBe(0);
    expect(resultado.find((i) => i.item.id === "B")!.lane).toBe(0);
  });

  it("libera a lane assim que a reserva anterior termina, mesmo com outras lanes ocupadas", () => {
    // A: 8-9 (lane 0), B: 8-10 (lane 1, sobrepõe A), C: 9-10 (A já liberou lane 0 às 9h)
    const itens = [r("A", 8 * 60, 9 * 60), r("B", 8 * 60, 10 * 60), r("C", 9 * 60, 10 * 60)];
    const resultado = calcularLanes(itens, obterIntervalo);
    expect(resultado.find((i) => i.item.id === "A")!.lane).toBe(0);
    expect(resultado.find((i) => i.item.id === "B")!.lane).toBe(1);
    expect(resultado.find((i) => i.item.id === "C")!.lane).toBe(0);
    expect(contarLanes(resultado)).toBe(2);
  });

  it("lista vazia -> zero lanes", () => {
    expect(contarLanes(calcularLanes([], obterIntervalo))).toBe(0);
  });

  it("uma única reserva -> uma lane", () => {
    const resultado = calcularLanes([r("A", 10 * 60, 11 * 60)], obterIntervalo);
    expect(contarLanes(resultado)).toBe(1);
    expect(resultado[0].lane).toBe(0);
  });
});
