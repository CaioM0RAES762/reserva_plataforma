import { describe, expect, it } from "vitest";
import {
  combinarDataHora,
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
    dataInicio: combinarDataHora("2026-08-10", "00:00"),
    dataFim: combinarDataHora("2026-08-10", "23:59"),
    motivo: "Feriado",
  };
  const bloqueioEspecifico: BloqueioAtivo = {
    id: "BLK-PLATAFORMA-X",
    plataformaId: "PLAT-X",
    dataInicio: combinarDataHora("2026-08-11", "08:00"),
    dataFim: combinarDataHora("2026-08-11", "12:00"),
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
      dataInicio: combinarDataHora("2026-08-10", "00:00"),
      dataFim: combinarDataHora("2026-08-10", "23:59"),
    });
    expect(resultado.map((r) => r.id)).toEqual(["RES-1", "RES-2"]);
  });

  it("não encontra reservas fora do intervalo do bloqueio", () => {
    const resultado = reservasDentroDoIntervalo(reservas, {
      dataInicio: combinarDataHora("2026-08-12", "00:00"),
      dataFim: combinarDataHora("2026-08-13", "00:00"),
    });
    expect(resultado).toEqual([]);
  });

  it("encontra apenas a reserva parcialmente coberta por um bloqueio estreito", () => {
    const resultado = reservasDentroDoIntervalo(reservas, {
      dataInicio: combinarDataHora("2026-08-10", "09:00"),
      dataFim: combinarDataHora("2026-08-10", "09:30"),
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
  const agora = combinarDataHora("2026-08-10", "08:00");

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
});
