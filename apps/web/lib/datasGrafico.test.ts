import { describe, expect, it } from "vitest";
import { formatarDataCompletaGrafico, formatarDiaMesEixo } from "./datasGrafico";

describe("datas dos gráficos de Relatórios", () => {
  it("eixo X em DD-MM", () => {
    expect(formatarDiaMesEixo("2026-09-24")).toBe("24-09");
    expect(formatarDiaMesEixo("2026-01-01")).toBe("01-01");
  });

  it("não desloca o dia por fuso (virada de mês/ano em UTC-3)", () => {
    expect(formatarDiaMesEixo("2026-10-01")).toBe("01-10");
    expect(formatarDiaMesEixo("2027-01-01")).toBe("01-01");
    expect(formatarDataCompletaGrafico("2026-10-01")).toBe("01/10/2026");
  });

  it("tooltip em DD/MM/YYYY; valor inesperado volta como veio", () => {
    expect(formatarDataCompletaGrafico("2026-09-24")).toBe("24/09/2026");
    expect(formatarDiaMesEixo("semana 3")).toBe("semana 3");
    expect(formatarDiaMesEixo(undefined)).toBe("");
  });
});
