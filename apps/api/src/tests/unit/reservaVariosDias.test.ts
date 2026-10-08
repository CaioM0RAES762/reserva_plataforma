import { describe, expect, it } from "vitest";
import {
  calcularMinutosDeUso,
  combinarDataHoraBrasilia,
  criarReservaSchema,
  duracaoPeriodoMinutos,
  formatarDuracaoPeriodo,
  formatarPeriodoReserva,
  periodosSeSobrepoem,
  recortarPeriodoNoDia,
  type PeriodoReserva,
} from "@plataformares/shared";
import {
  encontrarBloqueioConflitante,
  encontrarConflito,
  reservasDentroDoIntervalo,
  validarJanelaReserva,
  type RegrasJanelaReserva,
} from "../../services/conflito.service.js";
import { janelaTotalmenteVencida } from "../../services/reservaEstado.service.js";
import { montarDisponibilidadeDia, calcularProximoHorario } from "../../services/disponibilidadeDia.service.js";
import {
  calcularDemandaPorHora,
  calcularEvolucaoDiaria,
  calcularTotaisOperacionais,
  calcularUtilizacaoPlataformas,
} from "../../services/relatorio.service.js";

// Reserva de vários dias (migration 0029): o período vai de (data, horaInicio) até
// (dataFim, horaFim) e toda regra de tempo trabalha com o intervalo completo [início, fim).

const p = (data: string, horaInicio: string, dataFim: string, horaFim: string): PeriodoReserva => ({
  data,
  dataFim,
  horaInicio,
  horaFim,
});

// Semana de 2026-10-05 08:00 a 2026-10-12 08:00 (168h).
const SEMANA = p("2026-10-05", "08:00", "2026-10-12", "08:00");

describe("período de reserva", () => {
  it("duração cobre os dias inteiros entre início e fim", () => {
    expect(duracaoPeriodoMinutos(p("2026-10-05", "08:00", "2026-10-05", "17:00"))).toBe(9 * 60);
    expect(duracaoPeriodoMinutos(p("2026-10-05", "22:00", "2026-10-06", "02:00"))).toBe(4 * 60);
    expect(duracaoPeriodoMinutos(SEMANA)).toBe(168 * 60);
  });

  it("período invertido ou de duração zero não é válido", () => {
    expect(duracaoPeriodoMinutos(p("2026-10-05", "10:00", "2026-10-05", "10:00"))).toBe(0);
    expect(duracaoPeriodoMinutos(p("2026-10-06", "10:00", "2026-10-05", "12:00"))).toBeLessThan(0);
  });

  it("recorta o período em cada dia que ele toca (fim exclusivo, 1440 = continua)", () => {
    expect(recortarPeriodoNoDia(SEMANA, "2026-10-05")).toEqual({ inicioMin: 480, fimMin: 1440 });
    expect(recortarPeriodoNoDia(SEMANA, "2026-10-08")).toEqual({ inicioMin: 0, fimMin: 1440 });
    expect(recortarPeriodoNoDia(SEMANA, "2026-10-12")).toEqual({ inicioMin: 0, fimMin: 480 });
    expect(recortarPeriodoNoDia(SEMANA, "2026-10-13")).toBeNull();
    expect(recortarPeriodoNoDia(SEMANA, "2026-10-04")).toBeNull();
  });

  it("formata período e duração de forma legível", () => {
    expect(formatarPeriodoReserva(p("2026-10-05", "08:00", "2026-10-05", "17:00"))).toBe("05/10/2026 · 08:00–17:00");
    expect(formatarPeriodoReserva(SEMANA)).toBe("05/10/2026 08:00 → 12/10/2026 08:00");
    expect(formatarDuracaoPeriodo(170 * 60)).toBe("7 dias e 2h");
    expect(formatarDuracaoPeriodo(90)).toBe("1h30");
    expect(formatarDuracaoPeriodo(48 * 60)).toBe("2 dias");
  });
});

describe("conflito entre períodos completos", () => {
  const existente = { id: "E", ...SEMANA };

  it.each([
    ["só no primeiro dia", p("2026-10-05", "06:00", "2026-10-05", "09:00")],
    ["no meio da semana", p("2026-10-08", "10:00", "2026-10-08", "11:00")],
    ["só no último dia", p("2026-10-12", "07:00", "2026-10-12", "09:00")],
    ["contida na existente", p("2026-10-06", "00:00", "2026-10-07", "00:00")],
    ["envolvendo a existente", p("2026-10-04", "00:00", "2026-10-13", "00:00")],
    ["atravessando a meia-noite antes do início", p("2026-10-04", "22:00", "2026-10-05", "08:30")],
  ])("detecta conflito %s", (_rotulo, novo) => {
    expect(encontrarConflito([existente], novo)?.id).toBe("E");
    expect(periodosSeSobrepoem(novo, SEMANA)).toBe(true);
  });

  it("adjacência exata não é conflito (intervalo semiaberto)", () => {
    expect(encontrarConflito([existente], p("2026-10-12", "08:00", "2026-10-12", "10:00"))).toBeNull();
    expect(encontrarConflito([existente], p("2026-10-04", "20:00", "2026-10-05", "08:00"))).toBeNull();
  });

  it("mesmo horário em dias diferentes não conflita", () => {
    const dia = { id: "D", ...p("2026-10-05", "08:00", "2026-10-05", "10:00") };
    expect(encontrarConflito([dia], p("2026-10-06", "08:00", "2026-10-06", "10:00"))).toBeNull();
  });

  it("chamadas sem data continuam comparando só horários (compatibilidade)", () => {
    expect(encontrarConflito([{ id: "X", horaInicio: "08:00", horaFim: "10:00" }], { horaInicio: "09:00", horaFim: "11:00" })?.id).toBe("X");
  });

  it("bloqueio de vários dias pega reserva que toca qualquer parte dele", () => {
    const bloqueio = {
      id: "B",
      plataformaId: null,
      dataInicio: combinarDataHoraBrasilia("2026-10-07", "00:00"),
      dataFim: combinarDataHoraBrasilia("2026-10-09", "00:00"),
      motivo: "Manutenção preventiva",
    };
    expect(encontrarBloqueioConflitante([bloqueio], "P", SEMANA)?.id).toBe("B");
    expect(encontrarBloqueioConflitante([bloqueio], "P", p("2026-10-09", "00:00", "2026-10-09", "05:00"))).toBeNull();
    expect(
      reservasDentroDoIntervalo([{ id: "R", ...SEMANA }], { dataInicio: bloqueio.dataInicio, dataFim: bloqueio.dataFim })
    ).toHaveLength(1);
  });
});

describe("validarJanelaReserva com vários dias", () => {
  const regras: RegrasJanelaReserva = {
    antecedenciaMinimaHoras: 0,
    duracaoMaximaHoras: 720,
    horarioExpedienteInicio: "00:00",
    horarioExpedienteFim: "23:59",
  };
  const agora = combinarDataHoraBrasilia("2026-10-01", "00:00");
  const validar = (periodo: PeriodoReserva, extra: Partial<RegrasJanelaReserva> = {}, prioridade = "normal") =>
    validarJanelaReserva({ ...periodo, prioridade }, { ...regras, ...extra }, agora);

  it("aceita 170h e exatamente 720h", () => {
    expect(validar(p("2026-10-05", "08:00", "2026-10-12", "10:00")).ok).toBe(true); // 170h
    expect(validar(p("2026-10-05", "08:00", "2026-11-04", "08:00")).ok).toBe(true); // 720h
  });

  it("recusa 720h e um minuto, 721h, duração zero e período invertido", () => {
    expect(validar(p("2026-10-05", "08:00", "2026-11-04", "08:01")).ok).toBe(false);
    expect(validar(p("2026-10-05", "08:00", "2026-11-04", "09:00")).ok).toBe(false);
    expect(validar(p("2026-10-05", "08:00", "2026-10-05", "08:00")).ok).toBe(false);
    expect(validar(p("2026-10-06", "08:00", "2026-10-05", "09:00")).ok).toBe(false);
  });

  it("respeita a duração máxima configurada", () => {
    const resultado = validar(SEMANA, { duracaoMaximaHoras: 24 });
    expect(resultado).toEqual({ ok: false, erro: expect.stringContaining("24 hora(s)") });
  });

  it("expediente: início no expediente do 1º dia e fim no do último; noites liberadas", () => {
    const expediente = { horarioExpedienteInicio: "06:00", horarioExpedienteFim: "22:00" };
    expect(validar(p("2026-10-05", "08:00", "2026-10-07", "17:00"), expediente).ok).toBe(true);
    expect(validar(p("2026-10-05", "23:00", "2026-10-07", "17:00"), expediente).ok).toBe(false);
    expect(validar(p("2026-10-05", "08:00", "2026-10-07", "23:00"), expediente).ok).toBe(false);
    expect(validar(p("2026-10-05", "23:00", "2026-10-07", "23:00"), expediente, "urgente").ok).toBe(true);
  });
});

describe("criarReservaSchema", () => {
  const base = {
    plataformaId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    quantidadePessoas: 1,
    motivo: "Teste",
    telefoneContato: "31999999999",
  };

  it("sem dataFim assume o mesmo dia", () => {
    const r = criarReservaSchema.safeParse({ ...base, data: "2026-10-05", horaInicio: "08:00", horaFim: "10:00" });
    expect(r.success && r.data.dataFim).toBe("2026-10-05");
  });

  it("aceita hora final menor que a inicial quando o dia final é posterior", () => {
    const r = criarReservaSchema.safeParse({ ...base, data: "2026-10-05", dataFim: "2026-10-06", horaInicio: "22:00", horaFim: "06:00" });
    expect(r.success).toBe(true);
  });

  it("recusa fim antes do início e data final anterior", () => {
    expect(criarReservaSchema.safeParse({ ...base, data: "2026-10-05", horaInicio: "10:00", horaFim: "08:00" }).success).toBe(false);
    expect(
      criarReservaSchema.safeParse({ ...base, data: "2026-10-05", dataFim: "2026-10-04", horaInicio: "08:00", horaFim: "10:00" }).success
    ).toBe(false);
  });
});

describe("janela vencida e horímetro", () => {
  it("reserva de vários dias só vence no último dia", () => {
    const reserva = { data: "2026-10-05", dataFim: "2026-10-12", horaFim: "08:00" };
    expect(janelaTotalmenteVencida(reserva, { data: "2026-10-06", hora: "09:00" })).toBe(false);
    expect(janelaTotalmenteVencida(reserva, { data: "2026-10-12", hora: "07:59" })).toBe(false);
    expect(janelaTotalmenteVencida(reserva, { data: "2026-10-12", hora: "08:00" })).toBe(true);
  });

  it("horímetro conta todos os dias de um uso longo", () => {
    expect(
      calcularMinutosDeUso({
        horaInicio: "08:00",
        horaFim: "10:00",
        horaInicioReal: "08:00",
        horaFimReal: "10:00",
        inicioAutomatico: true,
        inicioAgendadoEm: "2026-10-05T08:00",
        inicioRealEm: "2026-10-05T08:00",
        fimRealEm: "2026-10-12T10:00",
      })
    ).toBe(170 * 60);
  });

  it("início automático sem registro usa o início agendado com data", () => {
    expect(
      calcularMinutosDeUso({
        horaInicio: "22:00",
        horaFim: "02:00",
        horaInicioReal: null,
        horaFimReal: "02:00",
        inicioAutomatico: true,
        inicioAgendadoEm: "2026-10-05T22:00",
        fimRealEm: "2026-10-06T02:00",
      })
    ).toBe(4 * 60);
  });

  it("reserva antiga sem instantes com data mantém a regra anterior", () => {
    expect(
      calcularMinutosDeUso({ horaInicio: "08:00", horaFim: "10:00", horaInicioReal: "08:15", horaFimReal: "09:45", inicioAutomatico: false })
    ).toBe(90);
  });
});

describe("grade do dia e próximo horário com reserva de vários dias", () => {
  const regras = {
    horarioExpedienteInicio: "06:00",
    horarioExpedienteFim: "22:00",
    duracaoMaximaHoras: 720,
    antecedenciaMinimaHoras: 0,
  };
  const linha = {
    id: "R",
    plataforma_id: "P",
    solicitante_id: "U",
    status: "agendada" as const,
    data: SEMANA.data,
    data_fim: SEMANA.dataFim,
    hora_inicio: SEMANA.horaInicio,
    hora_fim: SEMANA.horaFim,
    setor_id: "S",
    setor_nome: "Manutenção",
    motivo: "Semana",
  };
  const montar = (data: string) =>
    montarDisponibilidadeDia({
      data,
      regras,
      agora: combinarDataHoraBrasilia("2026-10-01", "00:00"),
      usuario: { perfil: "admin", setorId: null },
      plataformas: [
        { id: "P", codigo: "P1", nome: "P1", categoria: "elevatoria", localizacao: null, status: "disponivel", capacidade_operadores: 1 },
      ],
      reservas: [linha],
      bloqueios: [],
    }).plataformas[0].intervalos;

  it("dia do meio aparece inteiro, com o período completo e a continuação marcada", () => {
    const [intervalo] = montar("2026-10-08");
    expect(intervalo).toMatchObject({
      inicioMin: 0,
      fimMin: 1440,
      continuaAntes: true,
      continuaDepois: true,
      periodo: SEMANA,
    });
  });

  it("primeiro e último dia mostram só o pedaço do período", () => {
    expect(montar("2026-10-05")[0]).toMatchObject({ inicioMin: 480, fimMin: 1440, continuaDepois: true });
    expect(montar("2026-10-05")[0].continuaAntes).toBeUndefined();
    expect(montar("2026-10-12")[0]).toMatchObject({ inicioMin: 0, fimMin: 480, continuaAntes: true });
  });

  it("próximo horário livre pula os dias ocupados pela reserva longa", () => {
    const resultado = calcularProximoHorario({
      data: "2026-10-06",
      duracaoMinutos: 60,
      limiteDias: 14,
      regras,
      agora: combinarDataHoraBrasilia("2026-10-01", "00:00"),
      plataformaIndisponivel: false,
      reservas: [{ data: SEMANA.data, data_fim: SEMANA.dataFim, hora_inicio: SEMANA.horaInicio, hora_fim: SEMANA.horaFim }],
      bloqueios: [],
    });
    expect(resultado).toMatchObject({ encontrado: true, data: "2026-10-12", inicioMin: 480 });
  });
});

describe("relatórios com reserva de vários dias", () => {
  const reserva = { plataformaId: "P", status: "concluida" as const, ...SEMANA };

  it("horas totais somam o período inteiro", () => {
    expect(calcularTotaisOperacionais([reserva]).horasReservadasTotais).toBe(168);
  });

  it("evolução diária distribui as horas pelos dias e conta a reserva no dia em que começa", () => {
    const dias = calcularEvolucaoDiaria([reserva], { dateFrom: "2026-10-05", dateTo: "2026-10-12" });
    expect(dias.find((d) => d.data === "2026-10-05")).toMatchObject({ quantidadeReservas: 1, horasReservadas: 16 });
    expect(dias.find((d) => d.data === "2026-10-08")).toMatchObject({ quantidadeReservas: 0, horasReservadas: 24 });
    expect(dias.find((d) => d.data === "2026-10-12")).toMatchObject({ horasReservadas: 8 });
  });

  it("demanda por hora conta cada hora uma vez por reserva", () => {
    expect(calcularDemandaPorHora([reserva]).every((h) => h.quantidade === 1)).toBe(true);
  });

  it("utilização recorta o período ao intervalo do relatório", () => {
    const [linha] = calcularUtilizacaoPlataformas(
      [{ id: "P", codigo: "P1", nome: "P1", categoria: "elevatoria" }],
      [reserva],
      [],
      { dateFrom: "2026-10-08", dateTo: "2026-10-08" }
    );
    expect(linha.horasReservadas).toBe(24);
    expect(linha.taxaUtilizacao).toBe(100);
  });
});
