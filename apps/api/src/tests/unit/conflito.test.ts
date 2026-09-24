import { describe, expect, it } from "vitest";
import { combinarDataHoraBrasilia } from "@plataformares/shared";
import {
  encontrarBloqueioConflitante,
  encontrarConflito,
  horarioValido,
  reservasDentroDoIntervalo,
  validarJanelaReserva,
  type BloqueioAtivo,
  type RegrasJanelaReserva,
  type ReservaExistente,
} from "../../services/conflito.service.js";

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

// S9 (RN-RES-11): bloqueio de agenda ativo cobrindo o horário solicitado.
describe("encontrarBloqueioConflitante", () => {
  const bloqueioGlobal: BloqueioAtivo = {
    id: "BLK-GLOBAL",
    plataformaId: null,
    dataInicio: combinarDataHoraBrasilia("2026-08-10", "00:00"),
    dataFim: combinarDataHoraBrasilia("2026-08-10", "23:59"),
    motivo: "Feriado",
  };
  const bloqueioEspecifico: BloqueioAtivo = {
    id: "BLK-PLATAFORMA-X",
    plataformaId: "PLAT-X",
    dataInicio: combinarDataHoraBrasilia("2026-08-11", "08:00"),
    dataFim: combinarDataHoraBrasilia("2026-08-11", "12:00"),
    motivo: "Manutenção preventiva trimestral",
  };

  it("detecta conflito com bloqueio global (plataformaId null) para qualquer plataforma", () => {
    const conflito = encontrarBloqueioConflitante([bloqueioGlobal], "PLAT-Y", {
      data: "2026-08-10",
      horaInicio: "10:00",
      horaFim: "11:00",
    });
    expect(conflito?.id).toBe("BLK-GLOBAL");
  });

  it("detecta conflito com bloqueio específico da mesma plataforma", () => {
    const conflito = encontrarBloqueioConflitante([bloqueioEspecifico], "PLAT-X", {
      data: "2026-08-11",
      horaInicio: "09:00",
      horaFim: "10:00",
    });
    expect(conflito?.id).toBe("BLK-PLATAFORMA-X");
  });

  it("NÃO detecta conflito de bloqueio específico contra outra plataforma", () => {
    const conflito = encontrarBloqueioConflitante([bloqueioEspecifico], "PLAT-Y", {
      data: "2026-08-11",
      horaInicio: "09:00",
      horaFim: "10:00",
    });
    expect(conflito).toBeNull();
  });

  it("NÃO detecta conflito quando o horário está fora do período do bloqueio", () => {
    const conflito = encontrarBloqueioConflitante([bloqueioEspecifico], "PLAT-X", {
      data: "2026-08-11",
      horaInicio: "13:00",
      horaFim: "14:00",
    });
    expect(conflito).toBeNull();
  });

  it("adjacência exata (fim da reserva == início do bloqueio) NÃO é conflito", () => {
    const conflito = encontrarBloqueioConflitante([bloqueioEspecifico], "PLAT-X", {
      data: "2026-08-11",
      horaInicio: "07:00",
      horaFim: "08:00",
    });
    expect(conflito).toBeNull();
  });

  it("retorna null para lista de bloqueios vazia", () => {
    expect(
      encontrarBloqueioConflitante([], "PLAT-X", { data: "2026-08-11", horaInicio: "09:00", horaFim: "10:00" })
    ).toBeNull();
  });
});

// S9 (RN-BLK-01): reservas já existentes que colidem com o período de um novo bloqueio.
describe("reservasDentroDoIntervalo", () => {
  const reservas = [
    { id: "RES-1", data: "2026-08-10", horaInicio: "08:00", horaFim: "10:00" },
    { id: "RES-2", data: "2026-08-10", horaInicio: "14:00", horaFim: "16:00" },
    { id: "RES-3", data: "2026-08-11", horaInicio: "09:00", horaFim: "10:00" },
  ];

  it("encontra reservas dentro do intervalo do bloqueio (mesmo dia)", () => {
    const resultado = reservasDentroDoIntervalo(reservas, {
      dataInicio: combinarDataHoraBrasilia("2026-08-10", "00:00"),
      dataFim: combinarDataHoraBrasilia("2026-08-10", "23:59"),
    });
    expect(resultado.map((r) => r.id)).toEqual(["RES-1", "RES-2"]);
  });

  it("não encontra reservas fora do intervalo do bloqueio", () => {
    const resultado = reservasDentroDoIntervalo(reservas, {
      dataInicio: combinarDataHoraBrasilia("2026-08-12", "00:00"),
      dataFim: combinarDataHoraBrasilia("2026-08-13", "00:00"),
    });
    expect(resultado).toEqual([]);
  });

  it("encontra apenas a reserva parcialmente coberta por um bloqueio estreito", () => {
    const resultado = reservasDentroDoIntervalo(reservas, {
      dataInicio: combinarDataHoraBrasilia("2026-08-10", "09:00"),
      dataFim: combinarDataHoraBrasilia("2026-08-10", "09:30"),
    });
    expect(resultado.map((r) => r.id)).toEqual(["RES-1"]);
  });
});

// S12 (RF-CFG-01/02): validarJanelaReserva cobre as 3 regras de agendamento antes
// hardcoded/inexistentes (RN-RES-03/06), agora configuráveis via ConfiguracaoSistema.
describe("validarJanelaReserva", () => {
  const regras: RegrasJanelaReserva = {
    antecedenciaMinimaHoras: 2,
    duracaoMaximaHoras: 12,
    horarioExpedienteInicio: "06:00",
    horarioExpedienteFim: "22:00",
  };
  // combinarDataHoraBrasilia (não combinarDataHora): "agora" precisa ser um instante
  // real, do mesmo jeito que `new Date()` é em produção — usar a combinadora naive
  // aqui mascararia exatamente o bug de fuso horário que estas regras existem para
  // prevenir (ver comentário em validarJanelaReserva / conflito.service.ts).
  const agora = combinarDataHoraBrasilia("2026-08-10", "08:00");

  it("aceita reserva dentro da duração máxima, do expediente e com antecedência suficiente", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-11", horaInicio: "09:00", horaFim: "11:00", prioridade: "normal" },
      regras,
      agora
    );
    expect(resultado.ok).toBe(true);
  });

  it("rejeita duração acima de duracao_maxima_horas (RN-RES-03)", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-11", horaInicio: "08:00", horaFim: "21:00", prioridade: "normal" },
      regras,
      agora
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.erro).toContain("12 hora(s)");
  });

  it("aceita duração exatamente igual a duracao_maxima_horas (limite, não excedente)", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-11", horaInicio: "06:00", horaFim: "18:00", prioridade: "normal" },
      regras,
      agora
    );
    expect(resultado.ok).toBe(true);
  });

  it("rejeita reserva normal fora do horário de expediente (RN-RES-06)", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-11", horaInicio: "23:00", horaFim: "23:30", prioridade: "normal" },
      regras,
      agora
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.erro).toContain("horário de expediente");
  });

  it("aceita reserva urgente fora do horário de expediente (exceção da RN-RES-06)", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-11", horaInicio: "23:00", horaFim: "23:30", prioridade: "urgente" },
      regras,
      agora
    );
    expect(resultado.ok).toBe(true);
  });

  it("rejeita reserva com antecedência menor que a mínima configurada (RN-RES-03)", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-10", horaInicio: "09:00", horaFim: "10:00", prioridade: "normal" },
      regras,
      agora // agora = 2026-08-10 08:00 — só 1h de antecedência, mínimo configurado é 2h
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.erro).toContain("antecedência mínima");
  });

  it("aceita reserva com antecedência exatamente igual ao mínimo configurado", () => {
    const resultado = validarJanelaReserva(
      { data: "2026-08-10", horaInicio: "10:00", horaFim: "11:00", prioridade: "normal" },
      regras,
      agora // agora = 2026-08-10 08:00 — exatamente 2h de antecedência
    );
    expect(resultado.ok).toBe(true);
  });

  // Regressão do bug de fuso horário (combinarDataHora vs. combinarDataHoraBrasilia):
  // "agora" 2026-08-14 15:45 (Brasília), reserva 2026-08-14 17:45 — exatamente 120min
  // reais de antecedência. Com o bug antigo isto era rejeitado (exigia ~5h na prática).
  it("aceita reserva a exatamente 120 minutos reais de antecedência (regressão do bug de fuso)", () => {
    const agoraReal = combinarDataHoraBrasilia("2026-08-14", "15:45");
    const resultado = validarJanelaReserva(
      { data: "2026-08-14", horaInicio: "17:45", horaFim: "18:45", prioridade: "normal" },
      regras,
      agoraReal
    );
    expect(resultado.ok).toBe(true);
  });

  it("rejeita reserva a exatamente 119 minutos reais de antecedência", () => {
    const agoraReal = combinarDataHoraBrasilia("2026-08-14", "15:45");
    const resultado = validarJanelaReserva(
      { data: "2026-08-14", horaInicio: "17:44", horaFim: "18:44", prioridade: "normal" },
      regras,
      agoraReal
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.erro).toContain("antecedência mínima");
  });

  it("aceita reserva com mais de 2h de antecedência sem disparar o aviso incorretamente", () => {
    const agoraReal = combinarDataHoraBrasilia("2026-08-14", "15:45");
    const resultado = validarJanelaReserva(
      { data: "2026-08-14", horaInicio: "18:49", horaFim: "19:49", prioridade: "normal" },
      regras,
      agoraReal
    );
    expect(resultado.ok).toBe(true);
  });

  it("virada de dia: compara por instante real, não por hora isolada (expediente de 24h para isolar a antecedência)", () => {
    // Urgente não serve mais para isolar o expediente: desde a migration 0022 ela também
    // dispensa a antecedência. Um expediente de dia inteiro faz esse papel com prioridade normal.
    const regras24h: RegrasJanelaReserva = { ...regras, horarioExpedienteInicio: "00:00", horarioExpedienteFim: "23:59" };
    // Agora: 2026-08-14 23:30. Reserva: 2026-08-15 01:00 — 90 minutos reais, menor que
    // o mínimo (120min) — deve rejeitar mesmo cruzando a virada de dia.
    const agoraReal = combinarDataHoraBrasilia("2026-08-14", "23:30");
    const rejeitada = validarJanelaReserva(
      { data: "2026-08-15", horaInicio: "01:00", horaFim: "02:00", prioridade: "normal" },
      regras24h,
      agoraReal
    );
    expect(rejeitada.ok).toBe(false);

    // Mesmo "agora", reserva 2026-08-15 02:00 — 150 minutos reais, cruza a meia-noite e
    // deve ser aceita (a comparação é por instante real, não por hora isolada — uma
    // comparação ingênua de "01:00" e "02:00" como se fossem do mesmo dia da hora atual
    // erraria feio aqui).
    const aceita = validarJanelaReserva(
      { data: "2026-08-15", horaInicio: "02:00", horaFim: "03:00", prioridade: "normal" },
      regras24h,
      agoraReal
    );
    expect(aceita.ok).toBe(true);
  });

  // Migration 0022 — urgência dispensa a antecedência mínima (e só ela).
  describe("urgência x antecedência mínima", () => {
    const regras1h: RegrasJanelaReserva = { ...regras, antecedenciaMinimaHoras: 1 };
    const agora1630 = combinarDataHoraBrasilia("2026-08-10", "16:30");

    it("TESTE 5 — normal dentro da antecedência mínima continua bloqueada", () => {
      const resultado = validarJanelaReserva(
        { data: "2026-08-10", horaInicio: "16:40", horaFim: "17:40", prioridade: "normal" },
        regras1h,
        agora1630
      );
      expect(resultado.ok).toBe(false);
    });

    it("'alta' não é urgência: também respeita a antecedência", () => {
      const resultado = validarJanelaReserva(
        { data: "2026-08-10", horaInicio: "16:40", horaFim: "17:40", prioridade: "alta" },
        regras1h,
        agora1630
      );
      expect(resultado.ok).toBe(false);
    });

    it("TESTE 6 — urgente dentro da antecedência mínima é permitida", () => {
      const resultado = validarJanelaReserva(
        { data: "2026-08-10", horaInicio: "16:40", horaFim: "17:40", prioridade: "urgente" },
        regras1h,
        agora1630
      );
      expect(resultado.ok).toBe(true);
    });

    it("urgente não permite início que já passou (além da tolerância do slot)", () => {
      const resultado = validarJanelaReserva(
        { data: "2026-08-10", horaInicio: "15:30", horaFim: "16:30", prioridade: "urgente" },
        regras1h,
        agora1630
      );
      expect(resultado.ok).toBe(false);
    });

    it("urgente não escapa da duração máxima", () => {
      const resultado = validarJanelaReserva(
        { data: "2026-08-10", horaInicio: "17:00", horaFim: "23:30", prioridade: "urgente" },
        { ...regras1h, duracaoMaximaHoras: 4 },
        agora1630
      );
      expect(resultado.ok).toBe(false);
    });
  });

  it("rejeita reserva em data passada mesmo com horário nominal maior", () => {
    const agoraReal = combinarDataHoraBrasilia("2026-08-14", "15:45");
    const resultado = validarJanelaReserva(
      { data: "2026-08-13", horaInicio: "23:00", horaFim: "23:59", prioridade: "normal" },
      regras,
      agoraReal
    );
    expect(resultado.ok).toBe(false);
  });

  it("horário local (Brasília) vs. UTC: 17:45 de Brasília equivale a 20:45 UTC, não a 17:45 UTC", () => {
    const inicio = combinarDataHoraBrasilia("2026-08-14", "17:45");
    expect(inicio.toISOString()).toBe("2026-08-14T20:45:00.000Z");
  });
});
