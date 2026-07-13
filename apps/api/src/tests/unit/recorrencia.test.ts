import { describe, expect, it } from "vitest";
import {
  DataBaseInvalidaError,
  diaSemanaDe,
  gerarDatasRecorrencia,
} from "../../services/recorrencia.service.js";

describe("diaSemanaDe", () => {
  it("calcula o dia da semana (0=domingo) a partir de uma data ISO", () => {
    // 2026-08-10 é uma segunda-feira.
    expect(diaSemanaDe("2026-08-10")).toBe(1);
    // 2026-08-16 é um domingo.
    expect(diaSemanaDe("2026-08-16")).toBe(0);
  });
});

describe("gerarDatasRecorrencia", () => {
  it("gera exatamente 12 ocorrências semanais a partir da data-base, todas na mesma semana do mês", () => {
    const diaSemana = diaSemanaDe("2026-08-10");
    const datas = gerarDatasRecorrencia("2026-08-10", diaSemana, 12);

    expect(datas).toHaveLength(12);
    expect(datas).toEqual([
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("todas as datas geradas caem no mesmo dia da semana da data-base", () => {
    const diaSemana = diaSemanaDe("2026-08-10");
    const datas = gerarDatasRecorrencia("2026-08-10", diaSemana, 12);
    for (const data of datas) {
      expect(diaSemanaDe(data)).toBe(diaSemana);
    }
  });

  it("gera o número mínimo de 2 ocorrências corretamente", () => {
    const diaSemana = diaSemanaDe("2026-08-10");
    expect(gerarDatasRecorrencia("2026-08-10", diaSemana, 2)).toEqual(["2026-08-10", "2026-08-17"]);
  });

  it("rejeita quantidade abaixo de 2", () => {
    const diaSemana = diaSemanaDe("2026-08-10");
    expect(() => gerarDatasRecorrencia("2026-08-10", diaSemana, 1)).toThrow(RangeError);
  });

  it("rejeita quantidade acima de 12", () => {
    const diaSemana = diaSemanaDe("2026-08-10");
    expect(() => gerarDatasRecorrencia("2026-08-10", diaSemana, 13)).toThrow(RangeError);
  });

  it("rejeita data-base cujo dia da semana não confere com o informado", () => {
    // 2026-08-10 é segunda (1), não domingo (0).
    expect(() => gerarDatasRecorrencia("2026-08-10", 0, 4)).toThrow(DataBaseInvalidaError);
  });

  it("atravessa corretamente a virada de mês/ano", () => {
    const diaSemana = diaSemanaDe("2026-12-21");
    const datas = gerarDatasRecorrencia("2026-12-21", diaSemana, 3);
    expect(datas).toEqual(["2026-12-21", "2026-12-28", "2027-01-04"]);
  });
});
