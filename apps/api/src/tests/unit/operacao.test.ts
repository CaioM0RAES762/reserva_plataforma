/* Regras puras de operação (packages/shared/src/operacao.ts): horímetro por uso real e
 * janela dinâmica da "Agenda em curso". A idempotência do horímetro (uma reserva nunca soma
 * duas vezes) vive no banco — ver contabilizarUsoReserva e o teste de integração
 * horimetro_aprovacao.test.ts; aqui fica a aritmética. */

import { describe, expect, it } from "vitest";
import {
  calcularJanelaAgendaEmCurso,
  calcularMinutosDeUso,
  formatarHorimetro,
  horimetroAtualHoras,
} from "@plataformares/shared";

const base = { horaInicio: "14:00", horaFim: "16:00", inicioAutomatico: true };

describe("calcularMinutosDeUso", () => {
  it("TESTE 12 — início e fim automáticos: exatamente a duração agendada (2h)", () => {
    // Fim automático grava o horário agendado; início automático, o minuto em que o job rodou.
    expect(calcularMinutosDeUso({ ...base, horaInicioReal: "14:00", horaFimReal: "16:00" })).toBe(120);
  });

  it("TESTE 14 — início/fim manuais usam os horários reais (14:12–15:47 = 1h35)", () => {
    expect(
      calcularMinutosDeUso({ ...base, inicioAutomatico: false, horaInicioReal: "14:12", horaFimReal: "15:47" })
    ).toBe(95);
  });

  it("TESTE 15 — reserva que nunca iniciou (sem fim registrado) não soma", () => {
    expect(calcularMinutosDeUso({ ...base, horaInicioReal: null, horaFimReal: null })).toBe(0);
  });

  it("início manual nunca registrado = nunca houve uso, mesmo com fim gravado", () => {
    expect(calcularMinutosDeUso({ ...base, inicioAutomatico: false, horaInicioReal: null, horaFimReal: "16:00" })).toBe(0);
  });

  it("janela vencida com início automático (servidor fora do ar) conta a duração agendada", () => {
    expect(calcularMinutosDeUso({ ...base, horaInicioReal: null, horaFimReal: "16:00" })).toBe(120);
  });

  it("TESTE 16 — em uso desde 14:00 e substituída às 14:42 soma 42 min", () => {
    expect(calcularMinutosDeUso({ ...base, horaInicioReal: "14:00", horaFimReal: "14:42" })).toBe(42);
  });

  it("urgente que assumiu o horário às 14:42 conta só o próprio tempo", () => {
    expect(
      calcularMinutosDeUso({ horaInicio: "14:30", horaFim: "15:30", inicioAutomatico: true, horaInicioReal: "14:42", horaFimReal: "15:30" })
    ).toBe(48);
  });

  it("encerramento manual após a meia-noite não zera o uso", () => {
    expect(
      calcularMinutosDeUso({ horaInicio: "22:00", horaFim: "23:59", inicioAutomatico: false, horaInicioReal: "22:00", horaFimReal: "00:30" })
    ).toBe(150);
  });
});

describe("horímetro atual = baseline + uso", () => {
  it("preserva o baseline manual (460h + 2h = 462h)", () => {
    expect(horimetroAtualHoras(460, 120)).toBe(462);
    expect(formatarHorimetro(horimetroAtualHoras(460, 120))).toBe("462h");
  });

  it("frações aparecem como minutos", () => {
    expect(formatarHorimetro(horimetroAtualHoras(460, 95))).toBe("461h 35min");
  });

  it("sem baseline e sem uso = não informado", () => {
    expect(horimetroAtualHoras(null, 0)).toBeNull();
    expect(formatarHorimetro(null)).toBe("—");
  });

  it("sem baseline, mas com uso, parte de zero", () => {
    expect(horimetroAtualHoras(null, 90)).toBe(1.5);
  });
});

describe("calcularJanelaAgendaEmCurso", () => {
  const expediente = { inicio: "07:00", fim: "17:00" };
  const min = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));

  it("TESTE 19 — às 17h com reserva até 22:34, a janela vai até 23:00 (não para às 17h)", () => {
    const janela = calcularJanelaAgendaEmCurso({
      agoraMin: min("17:00"),
      intervalos: [
        { horaInicio: "17:30", horaFim: "18:30" },
        { horaInicio: "18:30", horaFim: "20:30" },
        { horaInicio: "19:32", horaFim: "22:34" },
      ],
      expediente,
    });
    expect(janela).toEqual({ inicioHora: 7, fimHora: 23 });
  });

  it("reserva antes do expediente puxa o início para trás", () => {
    const janela = calcularJanelaAgendaEmCurso({
      agoraMin: min("10:00"),
      intervalos: [{ horaInicio: "05:15", horaFim: "06:00" }],
      expediente,
    });
    expect(janela.inicioHora).toBe(5);
    expect(janela.fimHora).toBe(17);
  });

  it("sem expediente nem reservas, acompanha o horário atual com folga", () => {
    expect(calcularJanelaAgendaEmCurso({ agoraMin: min("16:37"), intervalos: [] })).toEqual({ inicioHora: 15, fimHora: 18 });
  });

  it("limitada ao dia: nunca antes de 00:00 nem depois de 24:00", () => {
    const janela = calcularJanelaAgendaEmCurso({
      agoraMin: min("23:40"),
      intervalos: [{ horaInicio: "00:10", horaFim: "23:59" }],
      expediente,
    });
    expect(janela).toEqual({ inicioHora: 0, fimHora: 24 });
  });
});
