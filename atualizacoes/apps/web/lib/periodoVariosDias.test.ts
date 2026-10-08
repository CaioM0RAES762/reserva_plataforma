import { describe, expect, it } from "vitest";
import { combinarDataHoraBrasilia } from "@plataformares/shared";
import { validarPeriodoVariosDias } from "./periodoVariosDias";

const regras = {
  antecedenciaMinimaHoras: 1,
  duracaoMaximaHoras: 720,
  horarioExpedienteInicio: "06:00",
  horarioExpedienteFim: "22:00",
};
const agora = combinarDataHoraBrasilia("2026-10-01", "10:00");

function validar(
  periodo: { data: string; dataFim: string; horaInicio: string; horaFim: string },
  extra: { urgente?: boolean; repetirSemanalmente?: boolean; duracaoMaximaHoras?: number } = {}
) {
  return validarPeriodoVariosDias({
    periodo,
    regras: { ...regras, ...(extra.duracaoMaximaHoras ? { duracaoMaximaHoras: extra.duracaoMaximaHoras } : {}) },
    urgente: extra.urgente ?? false,
    repetirSemanalmente: extra.repetirSemanalmente ?? false,
    agora,
  });
}

describe("validarPeriodoVariosDias", () => {
  it("aceita uma semana e calcula a duração e a travessia de dias", () => {
    const r = validar({ data: "2026-10-05", dataFim: "2026-10-12", horaInicio: "08:00", horaFim: "10:00" });
    expect(r.primeiroErro).toBeNull();
    expect(r.duracaoMinutos).toBe(170 * 60);
    expect(r.atravessaDias).toBe(true);
  });

  it("marca o fim quando passa do limite configurado, com a duração e o limite na mensagem", () => {
    const r = validar({ data: "2026-10-05", dataFim: "2026-10-12", horaInicio: "08:00", horaFim: "10:00" }, { duracaoMaximaHoras: 72 });
    expect(r.erros.horaFim).toContain("7 dias e 2h");
    expect(r.erros.horaFim).toContain("72h");
  });

  it("recusa data final anterior e fim antes do início", () => {
    expect(validar({ data: "2026-10-05", dataFim: "2026-10-04", horaInicio: "08:00", horaFim: "10:00" }).erros.dataFim).toBeDefined();
    expect(validar({ data: "2026-10-05", dataFim: "2026-10-05", horaInicio: "10:00", horaFim: "09:00" }).erros.horaFim).toBe(
      "O fim precisa ser depois do início."
    );
  });

  it("exige expediente no início e no fim (exceto urgente)", () => {
    const fora = validar({ data: "2026-10-05", dataFim: "2026-10-07", horaInicio: "23:00", horaFim: "23:30" });
    expect(fora.erros.horaInicio).toContain("expediente");
    expect(fora.erros.horaFim).toContain("expediente");
    const urgente = validar({ data: "2026-10-05", dataFim: "2026-10-07", horaInicio: "23:00", horaFim: "23:30" }, { urgente: true });
    expect(urgente.primeiroErro).toBeNull();
  });

  it("respeita a antecedência mínima", () => {
    const r = validar({ data: "2026-10-01", dataFim: "2026-10-02", horaInicio: "10:30", horaFim: "10:00" });
    expect(r.erros.horaInicio).toContain("antecedência");
  });

  it("recusa repetição semanal com 7 dias ou mais", () => {
    const r = validar({ data: "2026-10-05", dataFim: "2026-10-12", horaInicio: "08:00", horaFim: "08:00" }, { repetirSemanalmente: true });
    expect(r.erros.geral).toContain("7 dias");
    const curta = validar({ data: "2026-10-05", dataFim: "2026-10-07", horaInicio: "08:00", horaFim: "08:00" }, { repetirSemanalmente: true });
    expect(curta.erros.geral).toBeUndefined();
  });
});
