import { describe, expect, it } from "vitest";
import { combinarDataHoraBrasilia, type RegrasAgendaPublicas } from "@plataformares/shared";
import {
  calcularInicioMinimoMin,
  calcularProximoHorario,
  dataCivilValida,
  hojeEmBrasilia,
  montarDisponibilidadeDia,
  recortarBloqueioNoDia,
  somarDias,
  type BloqueioDiaRow,
  type EntradaProximoHorario,
  type PlataformaDiaRow,
  type ReservaDiaRow,
} from "../../services/disponibilidadeDia.service.js";

// Montagem PURA da disponibilidade (sem banco, sem relógio, sem sessão): é o que garante que
// a tela mostre exatamente o que o servidor decide, e que o motivo de uma reserva alheia
// nunca saia do servidor.

const REGRAS: RegrasAgendaPublicas = {
  horarioExpedienteInicio: "06:00",
  horarioExpedienteFim: "22:00",
  duracaoMaximaHoras: 12,
  antecedenciaMinimaHoras: 2,
};

const DATA = "2026-09-18";
// 2026-09-18 10:00 em Brasília.
const AGORA = combinarDataHoraBrasilia(DATA, "10:00");

const SETOR_TI = "11111111-1111-1111-1111-111111111111";
const SETOR_MANUTENCAO = "22222222-2222-2222-2222-222222222222";
const USUARIO_TI = "33333333-3333-3333-3333-333333333333";
const USUARIO_MANUTENCAO = "44444444-4444-4444-4444-444444444444";

const PLAT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLAT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function plataforma(id: string, extra: Partial<PlataformaDiaRow> = {}): PlataformaDiaRow {
  return {
    id,
    codigo: id.slice(0, 4).toUpperCase(),
    nome: `Plataforma ${id.slice(0, 1)}`,
    categoria: "elevatoria",
    localizacao: null,
    status: "disponivel",
    capacidade_operadores: 2,
    ...extra,
  };
}

function reserva(id: string, plataformaId: string, extra: Partial<ReservaDiaRow> = {}): ReservaDiaRow {
  return {
    id,
    plataforma_id: plataformaId,
    solicitante_id: USUARIO_MANUTENCAO,
    status: "agendada",
    hora_inicio: "08:00",
    hora_fim: "09:00",
    setor_id: SETOR_MANUTENCAO,
    setor_nome: "Manutenção",
    motivo: "Motivo interno da Manutenção",
    ...extra,
  };
}

/** Bloqueio expresso em horário de Brasília (é assim que o Admin o cadastra). */
function bloqueio(
  id: string,
  plataformaId: string | null,
  inicio: [string, string],
  fim: [string, string],
  motivo = "Bloqueio de teste"
): BloqueioDiaRow {
  return {
    id,
    plataforma_id: plataformaId,
    data_inicio: combinarDataHoraBrasilia(inicio[0], inicio[1]),
    data_fim: combinarDataHoraBrasilia(fim[0], fim[1]),
    motivo,
  };
}

function montar(extra: Partial<Parameters<typeof montarDisponibilidadeDia>[0]> = {}) {
  return montarDisponibilidadeDia({
    data: DATA,
    regras: REGRAS,
    agora: AGORA,
    usuario: { perfil: "colaborador", setorId: SETOR_TI },
    plataformas: [plataforma(PLAT_A)],
    reservas: [],
    bloqueios: [],
    ...extra,
  });
}

describe("bloqueio global x bloqueio da plataforma", () => {
  const bloqueios = [
    bloqueio("BLQ-GLOBAL", null, [DATA, "12:00"], [DATA, "13:00"], "Feriado interno"),
    bloqueio("BLQ-A", PLAT_A, [DATA, "15:00"], [DATA, "16:00"], "Manutenção preventiva da A"),
    bloqueio("BLQ-B", PLAT_B, [DATA, "17:00"], [DATA, "18:00"], "Só da B"),
  ];

  it("o global aparece em todas as plataformas; o específico só na sua", () => {
    const resposta = montar({ plataformas: [plataforma(PLAT_A), plataforma(PLAT_B)], bloqueios });
    const [a, b] = resposta.plataformas;

    expect(a.intervalos.map((i) => [i.id, i.tipo])).toEqual([
      ["BLQ-GLOBAL", "bloqueio_global"],
      ["BLQ-A", "bloqueio_plataforma"],
    ]);
    expect(b.intervalos.map((i) => [i.id, i.tipo])).toEqual([
      ["BLQ-GLOBAL", "bloqueio_global"],
      ["BLQ-B", "bloqueio_plataforma"],
    ]);
  });

  it("converte os instantes UTC do bloqueio em minutos de Brasília", () => {
    const [a] = montar({ bloqueios }).plataformas;
    expect(a.intervalos[0]).toMatchObject({ inicioMin: 720, fimMin: 780, motivo: "Feriado interno" });
    expect(a.intervalos[1]).toMatchObject({ inicioMin: 900, fimMin: 960 });
  });

  it("o motivo do bloqueio é público (mesmo para colaborador de qualquer setor)", () => {
    const [a] = montar({ bloqueios }).plataformas;
    expect(a.intervalos.find((i) => i.id === "BLQ-A")?.motivo).toBe("Manutenção preventiva da A");
  });
});

describe("recorte de meia-noite", () => {
  it("bloqueio que vem do dia anterior é recortado em 00:00", () => {
    const b = bloqueio("BLQ", null, ["2026-09-17", "22:00"], [DATA, "02:00"]);
    expect(recortarBloqueioNoDia(b, DATA)).toEqual({ inicioMin: 0, fimMin: 120 });
  });

  it("bloqueio que vira para o dia seguinte é recortado em 24:00 (1440)", () => {
    const b = bloqueio("BLQ", null, [DATA, "22:00"], ["2026-09-19", "06:00"]);
    expect(recortarBloqueioNoDia(b, DATA)).toEqual({ inicioMin: 1320, fimMin: 1440 });
  });

  it("o mesmo bloqueio aparece nos dois dias, cada um com o seu pedaço", () => {
    const b = bloqueio("BLQ", null, [DATA, "22:00"], ["2026-09-19", "06:00"]);
    expect(recortarBloqueioNoDia(b, "2026-09-19")).toEqual({ inicioMin: 0, fimMin: 360 });
  });

  it("bloqueio de vários dias cobre o dia do meio inteiro", () => {
    const b = bloqueio("BLQ", null, ["2026-09-17", "10:00"], ["2026-09-19", "10:00"]);
    expect(recortarBloqueioNoDia(b, DATA)).toEqual({ inicioMin: 0, fimMin: 1440 });
  });

  it("bloqueio que termina exatamente à meia-noite não toca o dia seguinte", () => {
    const b = bloqueio("BLQ", null, ["2026-09-17", "20:00"], [DATA, "00:00"]);
    expect(recortarBloqueioNoDia(b, DATA)).toBeNull();
    expect(recortarBloqueioNoDia(b, "2026-09-17")).toEqual({ inicioMin: 1200, fimMin: 1440 });
  });

  it("bloqueio que começa exatamente à meia-noite seguinte não toca o dia", () => {
    const b = bloqueio("BLQ", null, ["2026-09-19", "00:00"], ["2026-09-19", "05:00"]);
    expect(recortarBloqueioNoDia(b, DATA)).toBeNull();
  });

  it("noite de Brasília (21:00–24:00) cai no dia certo, mesmo estando no dia seguinte em UTC", () => {
    // 21:00 BRT = 00:00Z do dia seguinte: comparar por "data UTC" o jogaria para o dia errado.
    const b = bloqueio("BLQ", null, [DATA, "21:00"], ["2026-09-19", "00:00"]);
    expect(b.data_inicio.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(recortarBloqueioNoDia(b, DATA)).toEqual({ inicioMin: 1260, fimMin: 1440 });
    expect(recortarBloqueioNoDia(b, "2026-09-19")).toBeNull();
  });

  it("segundos/milissegundos arredondam PARA FORA (nunca deixam o minuto bloqueado parecer livre)", () => {
    const b: BloqueioDiaRow = {
      id: "BLQ",
      plataforma_id: null,
      data_inicio: new Date(combinarDataHoraBrasilia(DATA, "12:00").getTime() + 30_000),
      data_fim: new Date(combinarDataHoraBrasilia(DATA, "13:00").getTime() + 30_000),
      motivo: "x",
    };
    expect(recortarBloqueioNoDia(b, DATA)).toEqual({ inicioMin: 720, fimMin: 781 });
  });

  it("na resposta, bloqueios fora do dia consultado não aparecem", () => {
    const resposta = montar({
      bloqueios: [
        bloqueio("ANTES", null, ["2026-09-16", "08:00"], ["2026-09-16", "18:00"]),
        bloqueio("DEPOIS", null, ["2026-09-20", "08:00"], ["2026-09-20", "18:00"]),
      ],
    });
    expect(resposta.plataformas[0].intervalos).toEqual([]);
  });
});

describe("estados da reserva no dia", () => {
  it("pendente (solicitação), agendada, em_uso e concluida aparecem; cancelada e rejeitada, não", () => {
    const resposta = montar({
      reservas: [
        reserva("R-PEND", PLAT_A, { status: "pendente", hora_inicio: "06:00", hora_fim: "07:00" }),
        reserva("R-AGEN", PLAT_A, { status: "agendada", hora_inicio: "07:00", hora_fim: "08:00" }),
        reserva("R-USO", PLAT_A, { status: "em_uso", hora_inicio: "08:00", hora_fim: "09:00" }),
        reserva("R-CONC", PLAT_A, { status: "concluida", hora_inicio: "09:00", hora_fim: "10:00" }),
        reserva("R-CANC", PLAT_A, { status: "cancelada", hora_inicio: "10:00", hora_fim: "11:00" }),
        reserva("R-REJ", PLAT_A, { status: "rejeitada", hora_inicio: "11:00", hora_fim: "12:00" }),
      ],
    });
    const intervalos = resposta.plataformas[0].intervalos;
    expect(intervalos.map((i) => [i.id, i.status])).toEqual([
      ["R-PEND", "pendente"],
      ["R-AGEN", "agendada"],
      ["R-USO", "em_uso"],
      ["R-CONC", "concluida"],
    ]);
  });

  it("converte HH:mm em minutos e mantém os intervalos ordenados por início", () => {
    const resposta = montar({
      reservas: [
        reserva("R2", PLAT_A, { hora_inicio: "14:30", hora_fim: "23:59" }),
        reserva("R1", PLAT_A, { hora_inicio: "08:15", hora_fim: "09:45" }),
      ],
      bloqueios: [bloqueio("B", PLAT_A, [DATA, "11:00"], [DATA, "12:00"])],
    });
    expect(resposta.plataformas[0].intervalos.map((i) => [i.id, i.inicioMin, i.fimMin])).toEqual([
      ["R1", 495, 585],
      ["B", 660, 720],
      ["R2", 870, 1439],
    ]);
  });

  it("reservas ficam só na plataforma a que pertencem", () => {
    const resposta = montar({
      plataformas: [plataforma(PLAT_A), plataforma(PLAT_B)],
      reservas: [reserva("R-A", PLAT_A), reserva("R-B", PLAT_B, { hora_inicio: "10:00", hora_fim: "11:00" })],
    });
    expect(resposta.plataformas[0].intervalos.map((i) => i.id)).toEqual(["R-A"]);
    expect(resposta.plataformas[1].intervalos.map((i) => i.id)).toEqual(["R-B"]);
  });
});

describe("motivo mascarado e solicitante da reserva", () => {
  const reservas = [
    reserva("R-TI", PLAT_A, {
      setor_id: SETOR_TI,
      solicitante_id: USUARIO_TI,
      setor_nome: "TI",
      motivo: "Motivo do TI",
      hora_inicio: "08:00",
      hora_fim: "09:00",
    }),
    reserva("R-MAN", PLAT_A, {
      setor_id: SETOR_MANUTENCAO,
      setor_nome: "Manutenção",
      motivo: "Motivo da Manutenção",
      hora_inicio: "10:00",
      hora_fim: "11:00",
    }),
  ];

  it("colaborador vê o motivo da reserva do próprio setor e NÃO o da alheia", () => {
    const [ti, man] = montar({ reservas }).plataformas[0].intervalos;
    expect(ti).toMatchObject({ solicitanteId: USUARIO_TI, motivo: "Motivo do TI", setorNome: "TI" });
    expect(man).toMatchObject({ solicitanteId: USUARIO_MANUTENCAO, motivo: null, setorNome: "Manutenção" });
  });

  it("o texto do motivo alheio não aparece em lugar nenhum do payload", () => {
    const json = JSON.stringify(montar({ reservas }));
    expect(json).not.toContain("Motivo da Manutenção");
    expect(json).toContain("Motivo do TI");
  });

  it("gestor de setor segue a mesma regra do colaborador", () => {
    const [ti, man] = montar({ reservas, usuario: { perfil: "gestor_setor", setorId: SETOR_TI } }).plataformas[0]
      .intervalos;
    expect(ti.motivo).toBe("Motivo do TI");
    expect(man.motivo).toBeNull();
  });

  it("admin vê o motivo de todas sem alterar quem é o solicitante", () => {
    const [ti, man] = montar({ reservas, usuario: { perfil: "admin", setorId: null } }).plataformas[0].intervalos;
    expect(ti).toMatchObject({ solicitanteId: USUARIO_TI, motivo: "Motivo do TI" });
    expect(man).toMatchObject({ solicitanteId: USUARIO_MANUTENCAO, motivo: "Motivo da Manutenção" });
  });

  it("usuário sem setor (não admin) não recebe o motivo, mas recebe o solicitante real", () => {
    const [ti] = montar({ reservas, usuario: { perfil: "colaborador", setorId: null } }).plataformas[0].intervalos;
    expect(ti).toMatchObject({ solicitanteId: USUARIO_TI, motivo: null });
  });
});

describe("plataforma indisponível", () => {
  it.each([
    ["manutencao", true],
    ["inativa", true],
    ["disponivel", false],
    ["reservada", false],
  ] as const)("status %s → indisponivel=%s", (status, esperado) => {
    const [p] = montar({ plataformas: [plataforma(PLAT_A, { status })] }).plataformas;
    expect(p.indisponivel).toBe(esperado);
    expect(p.status).toBe(status);
  });

  it("projeta os campos públicos da plataforma", () => {
    const [p] = montar({
      plataformas: [plataforma(PLAT_A, { localizacao: "Fachada Leste", capacidade_operadores: null })],
    }).plataformas;
    expect(p).toMatchObject({
      id: PLAT_A,
      categoria: "elevatoria",
      localizacao: "Fachada Leste",
      capacidadeOperadores: null,
    });
  });
});

describe("agoraMin e inicioMinimoMin", () => {
  it("hoje: agoraMin é o minuto atual em Brasília e o início mínimo soma a antecedência", () => {
    const resposta = montar();
    expect(resposta.agoraMin).toBe(600);
    expect(resposta.inicioMinimoMin).toBe(720);
    expect(resposta.regras).toEqual(REGRAS);
  });

  it("hoje: arredonda o início mínimo PARA CIMA (10:00:30 + 2h só aceita a partir de 12:01)", () => {
    const resposta = montar({ agora: new Date(AGORA.getTime() + 30_000) });
    expect(resposta.agoraMin).toBe(600);
    expect(resposta.inicioMinimoMin).toBe(721);
  });

  it("dia futuro: agoraMin nulo e nenhum corte", () => {
    const resposta = montar({ data: "2026-09-25" });
    expect(resposta.agoraMin).toBeNull();
    expect(resposta.inicioMinimoMin).toBe(0);
  });

  it("dia passado: agoraMin nulo e nada mais pode começar (1440)", () => {
    const resposta = montar({ data: "2026-09-17" });
    expect(resposta.agoraMin).toBeNull();
    expect(resposta.inicioMinimoMin).toBe(1440);
  });

  it("hoje, tarde da noite: a antecedência empurra o início mínimo até o fim do dia (1440)", () => {
    const tarde = combinarDataHoraBrasilia(DATA, "23:30");
    expect(montar({ agora: tarde }).inicioMinimoMin).toBe(1440);
  });

  it("amanhã, logo depois da meia-noite de hoje: a antecedência ainda corta o começo do dia", () => {
    // Agora = 23:30 de 18/09; antecedência de 2h → 01:30 de 19/09 é o primeiro início aceito.
    const tarde = combinarDataHoraBrasilia(DATA, "23:30");
    expect(calcularInicioMinimoMin("2026-09-19", tarde, 2)).toBe(90);
  });

  it("'hoje' é o dia de Brasília, não o dia UTC", () => {
    // 22:00 BRT de 18/09 já é 01:00Z de 19/09.
    const noiteBrasilia = combinarDataHoraBrasilia(DATA, "22:00");
    expect(noiteBrasilia.toISOString()).toBe("2026-09-19T01:00:00.000Z");
    expect(hojeEmBrasilia(noiteBrasilia)).toBe(DATA);
    expect(montar({ agora: noiteBrasilia }).agoraMin).toBe(1320);
  });

  it("antecedência 0: início mínimo é o próprio instante atual", () => {
    expect(calcularInicioMinimoMin(DATA, AGORA, 0)).toBe(600);
  });
});

describe("utilitários de data civil", () => {
  it("dataCivilValida rejeita datas que o regex aceita mas não existem", () => {
    expect(dataCivilValida("2026-09-18")).toBe(true);
    expect(dataCivilValida("2028-02-29")).toBe(true);
    expect(dataCivilValida("2026-02-29")).toBe(false);
    expect(dataCivilValida("2026-02-31")).toBe(false);
    expect(dataCivilValida("2026-13-01")).toBe(false);
    expect(dataCivilValida("2026-00-10")).toBe(false);
  });

  it("somarDias atravessa mês e ano", () => {
    expect(somarDias("2026-01-31", 1)).toBe("2026-02-01");
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2026-03-01", -1)).toBe("2026-02-28");
  });
});

// ---------------------------------------------------------------------------------------
// Próximo horário disponível
// ---------------------------------------------------------------------------------------

function proximo(extra: Partial<EntradaProximoHorario> = {}) {
  return calcularProximoHorario({
    data: "2026-09-25",
    duracaoMinutos: 60,
    limiteDias: 14,
    regras: REGRAS,
    agora: AGORA,
    plataformaIndisponivel: false,
    reservas: [],
    bloqueios: [],
    ...extra,
  });
}

function bloqueioSimples(inicio: [string, string], fim: [string, string]) {
  return { data_inicio: combinarDataHoraBrasilia(inicio[0], inicio[1]), data_fim: combinarDataHoraBrasilia(fim[0], fim[1]) };
}

describe("calcularProximoHorario", () => {
  it("sem nada ocupado, começa na abertura do expediente", () => {
    expect(proximo()).toEqual({ encontrado: true, data: "2026-09-25", inicioMin: 360, fimMin: 420 });
  });

  it("pula reservas e devolve o primeiro trecho livre que comporta a duração", () => {
    const resposta = proximo({
      reservas: [
        { data: "2026-09-25", hora_inicio: "06:00", hora_fim: "10:00" },
        { data: "2026-09-25", hora_inicio: "10:00", hora_fim: "11:30" },
      ],
    });
    expect(resposta).toMatchObject({ data: "2026-09-25", inicioMin: 690, fimMin: 750 });
  });

  it("um vão menor que a duração pedida não serve", () => {
    const resposta = proximo({
      duracaoMinutos: 120,
      reservas: [
        { data: "2026-09-25", hora_inicio: "06:00", hora_fim: "07:00" },
        { data: "2026-09-25", hora_inicio: "08:00", hora_fim: "09:00" },
      ],
    });
    // vão 07:00–08:00 (60min) não cabe 120; 09:00 em diante cabe.
    expect(resposta).toMatchObject({ inicioMin: 540, fimMin: 660 });
  });

  it("bloqueio (global ou da plataforma) ocupa a agenda como uma reserva", () => {
    const resposta = proximo({ bloqueios: [bloqueioSimples(["2026-09-25", "06:00"], ["2026-09-25", "12:00"])] });
    expect(resposta).toMatchObject({ data: "2026-09-25", inicioMin: 720 });
  });

  it("dia todo ocupado → segue para o dia seguinte", () => {
    const resposta = proximo({ reservas: [{ data: "2026-09-25", hora_inicio: "06:00", hora_fim: "22:00" }] });
    expect(resposta).toEqual({ encontrado: true, data: "2026-09-26", inicioMin: 360, fimMin: 420 });
  });

  it("nunca passa do fim do expediente: reserva que não cabe até as 18:00 vai para o dia seguinte", () => {
    const resposta = proximo({
      regras: { ...REGRAS, horarioExpedienteFim: "18:00" },
      reservas: [{ data: "2026-09-25", hora_inicio: "06:00", hora_fim: "17:30" }],
    });
    expect(resposta).toMatchObject({ data: "2026-09-26", inicioMin: 360 });
  });

  it("bloqueio que atravessa a meia-noite tira o começo do dia seguinte", () => {
    const resposta = proximo({
      bloqueios: [bloqueioSimples(["2026-09-25", "20:00"], ["2026-09-26", "09:00"])],
      reservas: [{ data: "2026-09-25", hora_inicio: "06:00", hora_fim: "22:00" }],
    });
    expect(resposta).toMatchObject({ data: "2026-09-26", inicioMin: 540 });
  });

  it("hoje: respeita a antecedência mínima (agora 10:00 + 2h → 12:00)", () => {
    const resposta = proximo({ data: DATA });
    expect(resposta).toEqual({ encontrado: true, data: DATA, inicioMin: 720, fimMin: 780 });
  });

  it("hoje, sem tempo hábil restante: pula para amanhã", () => {
    const tarde = combinarDataHoraBrasilia(DATA, "21:00");
    const resposta = proximo({ data: DATA, agora: tarde });
    expect(resposta).toMatchObject({ data: "2026-09-19" });
  });

  it("data no passado: varre a partir dela mas só devolve o que ainda pode começar", () => {
    const resposta = proximo({ data: "2026-09-10" });
    expect(resposta).toMatchObject({ data: DATA, inicioMin: 720 });
  });

  it("expediente de dia inteiro (00:00–23:59): começa à meia-noite e termina no máximo às 23:59", () => {
    const regras = { ...REGRAS, horarioExpedienteInicio: "00:00", horarioExpedienteFim: "23:59" };
    expect(proximo({ regras })).toMatchObject({ inicioMin: 0, fimMin: 60 });
    // Com só 23:00–23:59 livre, uma reserva de 60min não cabe (terminaria às 24:00).
    const semFolga = proximo({
      regras,
      limiteDias: 1,
      reservas: [{ data: "2026-09-25", hora_inicio: "00:00", hora_fim: "23:00" }],
    });
    expect(semFolga.encontrado).toBe(false);
  });

  it("duração acima do máximo configurado → não encontrado", () => {
    expect(proximo({ duracaoMinutos: 12 * 60 + 15 })).toEqual({
      encontrado: false,
      data: null,
      inicioMin: null,
      fimMin: null,
    });
  });

  it("duração igual ao máximo, se couber no expediente, é encontrada", () => {
    const regras = { ...REGRAS, duracaoMaximaHoras: 12, horarioExpedienteInicio: "06:00", horarioExpedienteFim: "22:00" };
    expect(proximo({ regras, duracaoMinutos: 12 * 60 })).toMatchObject({ inicioMin: 360, fimMin: 1080 });
  });

  it("plataforma em manutenção/inativa → não encontrado", () => {
    expect(proximo({ plataformaIndisponivel: true }).encontrado).toBe(false);
  });

  it("nada livre dentro de limiteDias → não encontrado", () => {
    const resposta = proximo({
      limiteDias: 3,
      bloqueios: [bloqueioSimples(["2026-09-25", "00:00"], ["2026-09-28", "00:00"])],
    });
    expect(resposta.encontrado).toBe(false);
  });

  it("limiteDias 1 só olha o dia pedido", () => {
    const resposta = proximo({
      limiteDias: 1,
      reservas: [{ data: "2026-09-25", hora_inicio: "06:00", hora_fim: "22:00" }],
    });
    expect(resposta.encontrado).toBe(false);
  });

  it("a reserva do dia vizinho não interfere no dia consultado", () => {
    const resposta = proximo({ reservas: [{ data: "2026-09-26", hora_inicio: "06:00", hora_fim: "12:00" }] });
    expect(resposta).toMatchObject({ data: "2026-09-25", inicioMin: 360 });
  });
});
