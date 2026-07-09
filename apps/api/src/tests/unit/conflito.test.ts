import { describe, expect, it } from "vitest";
import { encontrarConflito, horarioValido, type ReservaExistente } from "../../services/conflito.service.js";

describe("horarioValido", () => {
  it("aceita horário final após o inicial", () => {
    expect(horarioValido("08:00", "10:00")).toBe(true);
  });

  it("rejeita horário final igual ao inicial", () => {
    expect(horarioValido("08:00", "08:00")).toBe(false);
  });

  it("rejeita horário final antes do inicial", () => {
    expect(horarioValido("10:00", "08:00")).toBe(false);
  });
});

describe("encontrarConflito", () => {
  const existentes: ReservaExistente[] = [
    { id: "RES-1", horaInicio: "08:00", horaFim: "10:00" },
    { id: "RES-2", horaInicio: "14:00", horaFim: "16:00" },
  ];

  it("detecta sobreposição total (novo horário engloba o existente)", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "07:00", horaFim: "11:00" });
    expect(conflito?.id).toBe("RES-1");
  });

  it("detecta sobreposição parcial no início", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "07:00", horaFim: "09:00" });
    expect(conflito?.id).toBe("RES-1");
  });

  it("detecta sobreposição parcial no final", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "09:00", horaFim: "11:00" });
    expect(conflito?.id).toBe("RES-1");
  });

  it("detecta novo horário totalmente contido no existente", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "08:30", horaFim: "09:30" });
    expect(conflito?.id).toBe("RES-1");
  });

  it("CASO LIMÍTROFE — adjacência exata (fim_nova == inicio_existente) NÃO é conflito", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "06:00", horaFim: "08:00" });
    expect(conflito).toBeNull();
  });

  it("CASO LIMÍTROFE — adjacência exata (inicio_nova == fim_existente) NÃO é conflito", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "10:00", horaFim: "12:00" });
    expect(conflito).toBeNull();
  });

  it("não detecta conflito quando não há sobreposição alguma", () => {
    const conflito = encontrarConflito(existentes, { horaInicio: "11:00", horaFim: "13:30" });
    expect(conflito).toBeNull();
  });

  it("ignora a própria reserva quando editando (ignorarReservaId)", () => {
    const conflito = encontrarConflito(existentes, {
      horaInicio: "08:00",
      horaFim: "10:00",
      ignorarReservaId: "RES-1",
    });
    expect(conflito).toBeNull();
  });

  it("ainda detecta conflito com OUTRA reserva mesmo ignorando a própria", () => {
    const conflito = encontrarConflito(existentes, {
      horaInicio: "09:00",
      horaFim: "15:00",
      ignorarReservaId: "RES-1",
    });
    expect(conflito?.id).toBe("RES-2");
  });

  it("retorna null para lista vazia", () => {
    expect(encontrarConflito([], { horaInicio: "08:00", horaFim: "09:00" })).toBeNull();
  });
});
