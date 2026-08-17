import { describe, expect, it } from "vitest";
import { combinarDataHoraBrasilia, validarAntecedenciaMinima } from "@plataformares/shared";

describe("combinarDataHoraBrasilia", () => {
  it("converte horário de Brasília para o instante UTC real correspondente (UTC-3)", () => {
    expect(combinarDataHoraBrasilia("2026-08-14", "17:45").toISOString()).toBe(
      "2026-08-14T20:45:00.000Z"
    );
  });

  it("cruza a virada de dia em UTC quando o horário de Brasília está perto da meia-noite", () => {
    // 22:00 de Brasília já é 01:00 do dia seguinte em UTC.
    expect(combinarDataHoraBrasilia("2026-08-14", "22:00").toISOString()).toBe(
      "2026-08-15T01:00:00.000Z"
    );
  });

  it("meia-noite de Brasília vira 03:00 UTC do mesmo dia civil", () => {
    expect(combinarDataHoraBrasilia("2026-08-14", "00:00").toISOString()).toBe(
      "2026-08-14T03:00:00.000Z"
    );
  });
});

describe("validarAntecedenciaMinima", () => {
  const agora = combinarDataHoraBrasilia("2026-08-14", "15:45");

  it("aceita exatamente o mínimo configurado (120 minutos)", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-14", "17:45");
    expect(validarAntecedenciaMinima(inicio, agora, 120).ok).toBe(true);
  });

  it("rejeita 1 minuto abaixo do mínimo (119 minutos)", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-14", "17:44");
    const resultado = validarAntecedenciaMinima(inicio, agora, 120);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.erro).toContain("2 hora(s)");
  });

  it("aceita folgadamente uma reserva com 3h de antecedência real", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-14", "18:45");
    expect(validarAntecedenciaMinima(inicio, agora, 120).ok).toBe(true);
  });

  it("rejeita datas passadas", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-13", "23:59");
    expect(validarAntecedenciaMinima(inicio, agora, 120).ok).toBe(false);
  });

  it("não confunde UTC com horário local: comparar contra um Date UTC ingênuo (sem converter) erraria por 3h", () => {
    // Se alguém, por engano, comparasse contra Date.UTC(2026,7,14,17,45) (rotulando
    // 17:45 de Brasília como se fosse UTC) em vez de combinarDataHoraBrasilia, o
    // resultado seria "ok" mesmo com só ~-60min de antecedência real — exatamente o bug
    // corrigido nesta tarefa. Este teste ancora o comportamento correto.
    const rotuladoComoUtcErrado = new Date(Date.UTC(2026, 7, 14, 17, 45));
    const resultado = validarAntecedenciaMinima(rotuladoComoUtcErrado, agora, 120);
    expect(resultado.ok).toBe(false); // -60min de "antecedência" nesse instante errado
    const correto = combinarDataHoraBrasilia("2026-08-14", "17:45");
    expect(validarAntecedenciaMinima(correto, agora, 120).ok).toBe(true);
  });

  it("respeita um mínimo configurável diferente de 120 (ex.: 60 minutos)", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-14", "16:45");
    expect(validarAntecedenciaMinima(inicio, agora, 60).ok).toBe(true);
    expect(validarAntecedenciaMinima(inicio, agora, 90).ok).toBe(false);
  });
});
