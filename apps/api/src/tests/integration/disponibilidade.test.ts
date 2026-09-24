import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, closePool } = await import("../../db/pool.js");
const { definirProviderEmailParaTeste } = await import("../../services/email.service.js");
const { criarProviderMockSempreAceita } = await import("../helpers/emailProviderMock.js");
const { obterRegrasReservaConfiguraveis } = await import("../../services/configuracao.service.js");
const { hojeEmBrasilia, somarDias } = await import("../../services/disponibilidadeDia.service.js");
const { combinarDataHoraBrasilia, horaParaMinutos, minutosParaHora } = await import("@plataformares/shared");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  inserirBloqueioTeste,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

// GET /disponibilidade (agregada, sem N+1) e GET /disponibilidade/proximo. Tudo provisionado
// por SQL: setores, usuários, plataformas, reservas e bloqueios — e removido no afterAll.

const PREFIXOS = { plataforma: "PLT-AGD-DSP", email: "teste.agd.dsp.", bloqueio: "AGD-DSP" };

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

interface IntervaloResposta {
  inicioMin: number;
  fimMin: number;
  tipo: "reserva" | "bloqueio_plataforma" | "bloqueio_global";
  id: string;
  status?: string;
  setorNome?: string;
  solicitanteId?: string;
  motivo?: string | null;
}
interface PlataformaResposta {
  id: string;
  status: string;
  indisponivel: boolean;
  capacidadeOperadores: number | null;
  intervalos: IntervaloResposta[];
}
interface DisponibilidadeResposta {
  data: string;
  regras: { horarioExpedienteInicio: string; horarioExpedienteFim: string };
  agoraMin: number | null;
  inicioMinimoMin: number;
  plataformas: PlataformaResposta[];
}

const DIA = dataFuturaAleatoria();
const DIA_ANTERIOR = somarDias(DIA, -1);
const DIA_SEGUINTE = somarDias(DIA, 1);

let app: FastifyInstance;
let setorTi: Setor;
let setorManutencao: Setor;
let colabTi: Usuario;
let colabTiB: Usuario;
let colabMan: Usuario;
let admin: Usuario;
let p1: string;
let p2Manutencao: string;
let p3Inativa: string;
const ids: Record<string, string> = {};

async function get(url: string, usuario: Usuario | null) {
  return app.inject({ method: "GET", url, headers: usuario ? { cookie: usuario.cookie } : {} });
}

async function disponibilidade(data: string, usuario: Usuario, plataformaId?: string) {
  const qs = new URLSearchParams({ data });
  if (plataformaId) qs.set("plataformaId", plataformaId);
  const response = await get(`/api/v1/disponibilidade?${qs}`, usuario);
  expect(response.statusCode).toBe(200);
  return response.json() as DisponibilidadeResposta;
}

function noBrasilia(data: string, hora: string): Date {
  return combinarDataHoraBrasilia(data, hora);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  definirProviderEmailParaTeste(criarProviderMockSempreAceita());

  await limparResiduos(PREFIXOS);

  setorTi = await garantirSetor("TI");
  setorManutencao = await garantirSetor("Manutenção");
  colabTi = await criarUsuarioTeste({
    email: `${PREFIXOS.email}ti@metalsider.com.br`,
    nome: "Colaborador TI (teste disponibilidade)",
    perfil: "colaborador",
    setorId: setorTi.id,
  });
  colabTiB = await criarUsuarioTeste({
    email: `${PREFIXOS.email}ti.b@metalsider.com.br`,
    nome: "Outro colaborador TI (teste disponibilidade)",
    perfil: "colaborador",
    setorId: setorTi.id,
  });
  colabMan = await criarUsuarioTeste({
    email: `${PREFIXOS.email}man@metalsider.com.br`,
    nome: "Colaborador Manutenção (teste disponibilidade)",
    perfil: "colaborador",
    setorId: setorManutencao.id,
  });
  admin = await criarUsuarioTeste({
    email: `${PREFIXOS.email}admin@metalsider.com.br`,
    nome: "Admin (teste disponibilidade)",
    perfil: "admin",
    setorId: null,
  });
  p1 = await criarPlataformaTeste({ codigo: "PLT-AGD-DSP-1", nome: "Plataforma disponível (teste)", capacidadeOperadores: 3 });
  p2Manutencao = await criarPlataformaTeste({
    codigo: "PLT-AGD-DSP-2",
    nome: "Plataforma em manutenção (teste)",
    status: "manutencao",
  });
  p3Inativa = await criarPlataformaTeste({ codigo: "PLT-AGD-DSP-3", nome: "Plataforma inativa (teste)", status: "inativa" });

  const reserva = (
    chave: string,
    setor: Setor,
    solicitante: Usuario,
    horaInicio: string,
    horaFim: string,
    status: string,
    motivo: string,
    data = DIA
  ) =>
    inserirReservaTeste({
      setorId: setor.id,
      solicitanteId: solicitante.id,
      plataformaId: p1,
      data,
      horaInicio,
      horaFim,
      status,
      motivo,
    }).then((id) => {
      ids[chave] = id;
    });

  await reserva("resTi", setorTi, colabTi, "08:00", "09:00", "agendada", "Segredo do TI");
  await reserva("resMan", setorManutencao, colabMan, "10:00", "11:00", "agendada", "Segredo da Manutenção");
  await reserva("resConcluida", setorTi, colabTi, "12:00", "13:00", "concluida", "Já encerrada");
  await reserva("resCancelada", setorTi, colabTi, "14:00", "15:00", "cancelada", "Cancelada");
  await reserva("resRejeitada", setorTi, colabTi, "15:00", "16:00", "rejeitada", "Rejeitada (legado)");
  await reserva("resEmUso", setorManutencao, colabMan, "16:00", "17:00", "em_uso", "Em andamento");

  const bloqueio = async (chave: string, plataformaId: string | null, inicio: Date, fim: Date, motivo: string) => {
    ids[chave] = await inserirBloqueioTeste({
      plataformaId,
      inicio,
      fim,
      motivo: `${PREFIXOS.bloqueio} ${motivo}`,
      criadoPorId: admin.id,
    });
  };
  await bloqueio("bloqGlobal", null, noBrasilia(DIA, "18:00"), noBrasilia(DIA, "19:00"), "global");
  await bloqueio("bloqP1", p1, noBrasilia(DIA, "20:00"), noBrasilia(DIA, "21:00"), "da plataforma");
  // Vem da noite anterior e termina de madrugada: só o pedaço de DIA (00:00–01:00) conta.
  await bloqueio("bloqVemDeOntem", p1, noBrasilia(DIA_ANTERIOR, "22:30"), noBrasilia(DIA, "01:00"), "atravessa ontem");
  // 21:30 BRT já é o dia seguinte em UTC — o recorte tem de usar o dia de Brasília.
  await bloqueio("bloqVaiParaAmanha", p1, noBrasilia(DIA, "21:30"), noBrasilia(DIA_SEGUINTE, "02:00"), "atravessa amanhã");
});

afterAll(async () => {
  definirProviderEmailParaTeste(null);
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setorTi);
  await removerSetorSeCriado(setorManutencao);
  await app.close();
  await closePool();
});

describe("GET /disponibilidade — contrato e validação", () => {
  it("sem sessão → 401", async () => {
    expect((await get(`/api/v1/disponibilidade?data=${DIA}`, null)).statusCode).toBe(401);
  });

  it.each([
    ["data ausente", "/api/v1/disponibilidade"],
    ["data fora do formato", "/api/v1/disponibilidade?data=18-09-2026"],
    ["data que não existe no calendário", "/api/v1/disponibilidade?data=2027-02-31"],
    ["plataformaId que não é UUID", `/api/v1/disponibilidade?data=${DIA}&plataformaId=abc`],
  ])("%s → 422 padrão", async (_rotulo, url) => {
    const response = await get(url, colabTi);
    expect(response.statusCode).toBe(422);
    expect(response.json().erro).toBe("Parâmetros inválidos.");
    expect(response.json().detalhes).toBeDefined();
  });

  it("plataformaId inexistente → 404", async () => {
    const response = await get(
      `/api/v1/disponibilidade?data=${DIA}&plataformaId=00000000-0000-4000-8000-000000000000`,
      colabTi
    );
    expect(response.statusCode).toBe(404);
  });

  it("responde no-store e traz as regras públicas iguais às de POST /reservas", async () => {
    const response = await get(`/api/v1/disponibilidade?data=${DIA}&plataformaId=${p1}`, colabTi);
    expect(response.headers["cache-control"]).toBe("no-store");
    const corpo = response.json() as DisponibilidadeResposta;
    const regras = await obterRegrasReservaConfiguraveis();
    expect(corpo.regras).toMatchObject({
      horarioExpedienteInicio: regras.horarioExpedienteInicio,
      horarioExpedienteFim: regras.horarioExpedienteFim,
      duracaoMaximaHoras: regras.duracaoMaximaHoras,
      antecedenciaMinimaHoras: regras.antecedenciaMinimaHoras,
    });
    expect(corpo.data).toBe(DIA);
  });

  it("filtrar por plataformaId devolve só ela", async () => {
    const corpo = await disponibilidade(DIA, colabTi, p1);
    expect(corpo.plataformas.map((p) => p.id.toLowerCase())).toEqual([p1.toLowerCase()]);
  });
});

describe("GET /disponibilidade — o dia montado", () => {
  it("lista reservas e bloqueios recortados no dia de Brasília, ordenados; cancelada/rejeitada ficam de fora", async () => {
    const corpo = await disponibilidade(DIA, colabTi, p1);
    const [plataforma] = corpo.plataformas;

    expect(plataforma.intervalos.map((i) => [i.tipo, i.inicioMin, i.fimMin, i.status ?? null])).toEqual([
      ["bloqueio_plataforma", 0, 60, null], // veio de ontem
      ["reserva", 480, 540, "agendada"],
      ["reserva", 600, 660, "agendada"],
      ["reserva", 720, 780, "concluida"],
      ["reserva", 960, 1020, "em_uso"],
      ["bloqueio_global", 1080, 1140, null],
      ["bloqueio_plataforma", 1200, 1260, null],
      ["bloqueio_plataforma", 1290, 1440, null], // vai para amanhã, cortado em 24:00
    ]);

    const idsNaResposta = plataforma.intervalos.map((i) => i.id.toLowerCase());
    expect(idsNaResposta).not.toContain(ids.resCancelada.toLowerCase());
    expect(idsNaResposta).not.toContain(ids.resRejeitada.toLowerCase());
    expect(idsNaResposta).toContain(ids.resConcluida.toLowerCase());
  });

  it("o pedaço do bloqueio que atravessa a meia-noite aparece também no dia vizinho", async () => {
    const amanha = await disponibilidade(DIA_SEGUINTE, colabTi, p1);
    const [plataforma] = amanha.plataformas;
    expect(plataforma.intervalos.map((i) => [i.tipo, i.inicioMin, i.fimMin])).toEqual([["bloqueio_plataforma", 0, 120]]);
  });

  it("horas das reservas saem em minutos a partir de HH:mm", async () => {
    const [plataforma] = (await disponibilidade(DIA, colabTi, p1)).plataformas;
    const ti = plataforma.intervalos.find((i) => i.id.toLowerCase() === ids.resTi.toLowerCase());
    expect(ti).toMatchObject({ inicioMin: horaParaMinutos("08:00"), fimMin: horaParaMinutos("09:00") });
  });

  it("endpoint devolve o solicitante real e mantém o motivo restrito ao setor", async () => {
    const corpo = await disponibilidade(DIA, colabTi, p1);
    const porId = new Map(corpo.plataformas[0].intervalos.map((i) => [i.id.toLowerCase(), i]));

    expect(porId.get(ids.resTi.toLowerCase())).toMatchObject({
      solicitanteId: colabTi.id,
      motivo: "Segredo do TI",
      setorNome: setorTi.nome,
    });
    expect(porId.get(ids.resMan.toLowerCase())).toMatchObject({
      solicitanteId: colabMan.id,
      motivo: null,
      setorNome: setorManutencao.nome,
    });
    // O texto do motivo alheio não trafega no payload.
    expect(JSON.stringify(corpo)).not.toContain("Segredo da Manutenção");
  });

  it("dois usuários do mesmo setor recebem o mesmo solicitanteId, sem transferir ownership", async () => {
    const corpoA = await disponibilidade(DIA, colabTi, p1);
    const corpoB = await disponibilidade(DIA, colabTiB, p1);
    const reservaAParaA = corpoA.plataformas[0].intervalos.find(
      (i) => i.id.toLowerCase() === ids.resTi.toLowerCase()
    );
    const reservaAParaB = corpoB.plataformas[0].intervalos.find(
      (i) => i.id.toLowerCase() === ids.resTi.toLowerCase()
    );

    expect(reservaAParaA?.solicitanteId?.toLowerCase()).toBe(colabTi.id.toLowerCase());
    expect(reservaAParaB?.solicitanteId?.toLowerCase()).toBe(colabTi.id.toLowerCase());
    expect(reservaAParaB?.solicitanteId?.toLowerCase()).not.toBe(colabTiB.id.toLowerCase());
  });

  it("o motivo do bloqueio é público", async () => {
    const [plataforma] = (await disponibilidade(DIA, colabMan, p1)).plataformas;
    const global = plataforma.intervalos.find((i) => i.tipo === "bloqueio_global");
    expect(global?.motivo).toBe(`${PREFIXOS.bloqueio} global`);
  });

  it("o colaborador de outro setor recebe os mesmos donos, com os motivos invertidos por visibilidade", async () => {
    const corpo = await disponibilidade(DIA, colabMan, p1);
    const porId = new Map(corpo.plataformas[0].intervalos.map((i) => [i.id.toLowerCase(), i]));
    expect(porId.get(ids.resMan.toLowerCase())).toMatchObject({ solicitanteId: colabMan.id, motivo: "Segredo da Manutenção" });
    expect(porId.get(ids.resTi.toLowerCase())).toMatchObject({ solicitanteId: colabTi.id, motivo: null });
  });

  it("Admin vê o motivo de todas as reservas sem se tornar dono delas", async () => {
    const corpo = await disponibilidade(DIA, admin, p1);
    const porId = new Map(corpo.plataformas[0].intervalos.map((i) => [i.id.toLowerCase(), i]));
    expect(porId.get(ids.resTi.toLowerCase())).toMatchObject({ solicitanteId: colabTi.id, motivo: "Segredo do TI" });
    expect(porId.get(ids.resMan.toLowerCase())).toMatchObject({
      solicitanteId: colabMan.id,
      motivo: "Segredo da Manutenção",
    });
  });

  it("sem plataformaId, todas as plataformas vêm numa resposta só; manutenção/inativa saem indisponíveis", async () => {
    const corpo = await disponibilidade(DIA, colabTi);
    const porId = new Map(corpo.plataformas.map((p) => [p.id.toLowerCase(), p]));

    expect(porId.get(p1.toLowerCase())).toMatchObject({ indisponivel: false, status: "disponivel", capacidadeOperadores: 3 });
    expect(porId.get(p2Manutencao.toLowerCase())).toMatchObject({ indisponivel: true, status: "manutencao" });
    expect(porId.get(p3Inativa.toLowerCase())).toMatchObject({ indisponivel: true, status: "inativa" });

    // Bloqueio GLOBAL aparece em todas; o da plataforma, só na P1.
    for (const id of [p1, p2Manutencao, p3Inativa]) {
      expect(porId.get(id.toLowerCase())?.intervalos.some((i) => i.tipo === "bloqueio_global")).toBe(true);
    }
    expect(porId.get(p2Manutencao.toLowerCase())?.intervalos.some((i) => i.tipo === "bloqueio_plataforma")).toBe(false);
  });
});

describe("GET /disponibilidade — agoraMin e inicioMinimoMin", () => {
  it("data futura: sem agoraMin e sem corte", async () => {
    const corpo = await disponibilidade(DIA, colabTi, p1);
    expect(corpo.agoraMin).toBeNull();
    expect(corpo.inicioMinimoMin).toBe(0);
  });

  it("data passada: nada mais pode começar (1440)", async () => {
    const ontem = somarDias(hojeEmBrasilia(new Date()), -1);
    const corpo = await disponibilidade(ontem, colabTi, p1);
    expect(corpo.agoraMin).toBeNull();
    expect(corpo.inicioMinimoMin).toBe(1440);
  });

  it("hoje: agoraMin é o minuto de Brasília e o início mínimo soma a antecedência configurada", async () => {
    const regras = await obterRegrasReservaConfiguraveis();
    const hoje = hojeEmBrasilia(new Date());
    const antes = Date.now();
    const corpo = await disponibilidade(hoje, colabTi, p1);
    const depois = Date.now();

    // Se o dia virou no meio da requisição não há o que comparar (janela de milissegundos).
    if (hojeEmBrasilia(new Date(depois)) !== hoje) return;
    const minutoDe = (instante: number) => Math.floor((instante - noBrasilia(hoje, "00:00").getTime()) / 60_000);

    expect(corpo.agoraMin).not.toBeNull();
    expect(corpo.agoraMin!).toBeGreaterThanOrEqual(minutoDe(antes));
    expect(corpo.agoraMin!).toBeLessThanOrEqual(minutoDe(depois));
    // Nenhum início antes de agora + antecedência (teto: 1440 = nada mais começa hoje).
    expect(corpo.inicioMinimoMin).toBeGreaterThanOrEqual(Math.min(1440, minutoDe(antes) + regras.antecedenciaMinimaHoras * 60));
    expect(corpo.inicioMinimoMin).toBeLessThanOrEqual(1440);
  });
});

describe("Sem N+1: o número de consultas não depende da quantidade de plataformas", () => {
  it("GET /disponibilidade faz exatamente 3 consultas (plataformas, reservas, bloqueios)", async () => {
    await obterRegrasReservaConfiguraveis(); // aquece o cache de configuração (não é consulta da rota)
    const pool = await getPool();
    const espiao = vi.spyOn(pool, "request");
    try {
      const response = await get(`/api/v1/disponibilidade?data=${DIA}`, colabTi);
      expect(response.statusCode).toBe(200);
      expect((response.json() as DisponibilidadeResposta).plataformas.length).toBeGreaterThanOrEqual(3);
      expect(espiao).toHaveBeenCalledTimes(3);
    } finally {
      espiao.mockRestore();
    }
  });

  it("GET /disponibilidade/proximo varrendo 30 dias faz 3 consultas (plataforma, reservas, bloqueios)", async () => {
    await obterRegrasReservaConfiguraveis();
    const pool = await getPool();
    const espiao = vi.spyOn(pool, "request");
    try {
      const response = await get(
        `/api/v1/disponibilidade/proximo?plataformaId=${p1}&data=${DIA}&duracaoMinutos=60&limiteDias=30`,
        colabTi
      );
      expect(response.statusCode).toBe(200);
      expect(espiao).toHaveBeenCalledTimes(3);
    } finally {
      espiao.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------
// /disponibilidade/proximo
// ---------------------------------------------------------------------------------------

interface ProximoResposta {
  encontrado: boolean;
  data: string | null;
  inicioMin: number | null;
  fimMin: number | null;
}

async function proximo(params: Record<string, string | number>, usuario: Usuario | null = colabTi) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return get(`/api/v1/disponibilidade/proximo?${qs}`, usuario);
}

describe("GET /disponibilidade/proximo", () => {
  // Posições relativas ao expediente configurado no banco (que o Admin pode mudar).
  let ini: number;
  let fim: number;
  const D2 = somarDias(DIA, 5);
  const D3 = somarDias(DIA, 10);
  const D4 = somarDias(DIA, 15);

  beforeAll(async () => {
    const regras = await obterRegrasReservaConfiguraveis();
    ini = horaParaMinutos(regras.horarioExpedienteInicio);
    fim = horaParaMinutos(regras.horarioExpedienteFim);
    // Precondição do cenário: precisa caber ~7h de expediente. Falha alto se o banco de dev
    // estiver com um expediente estreito demais — em vez de o teste passar sem provar nada.
    expect(fim - ini, "expediente configurado é estreito demais para este cenário").toBeGreaterThanOrEqual(420);

    const na = (chave: string, data: string, de: number, ate: number, status: string, setor: Setor, usuario: Usuario) =>
      inserirReservaTeste({
        setorId: setor.id,
        solicitanteId: usuario.id,
        plataformaId: p1,
        data,
        horaInicio: minutosParaHora(de),
        horaFim: minutosParaHora(ate),
        status,
      }).then((id) => {
        ids[chave] = id;
      });

    // D2: concluida (ignorada) | agendada | cancelada (ignorada) | bloqueio global | livre
    await na("d2Concluida", D2, ini, ini + 60, "concluida", setorTi, colabTi);
    await na("d2Agendada", D2, ini + 60, ini + 180, "agendada", setorTi, colabTi);
    await na("d2Cancelada", D2, ini + 180, ini + 240, "cancelada", setorTi, colabTi);
    ids.d2Bloqueio = await inserirBloqueioTeste({
      plataformaId: null,
      inicio: noBrasilia(D2, minutosParaHora(ini + 240)),
      fim: noBrasilia(D2, minutosParaHora(ini + 300)),
      motivo: `${PREFIXOS.bloqueio} proximo global`,
      criadoPorId: admin.id,
    });
    // D3: bloqueio global de dia inteiro.
    ids.d3Bloqueio = await inserirBloqueioTeste({
      plataformaId: p1,
      inicio: noBrasilia(D3, "00:00"),
      fim: noBrasilia(somarDias(D3, 1), "00:00"),
      motivo: `${PREFIXOS.bloqueio} proximo dia inteiro`,
      criadoPorId: admin.id,
    });
    // D4: em_uso ocupa horário; pendente (solicitação ainda não aprovada) não ocupa.
    await na("d4Pendente", D4, ini, ini + 120, "pendente", setorTi, colabTi);
    await na("d4EmUso", D4, ini + 120, ini + 240, "em_uso", setorManutencao, colabMan);
  });

  it("sem sessão → 401", async () => {
    expect((await proximo({ plataformaId: p1, data: DIA }, null)).statusCode).toBe(401);
  });

  it.each([
    ["sem plataformaId", { data: DIA }],
    ["plataformaId inválido", { plataformaId: "abc", data: DIA }],
    ["data inválida", { plataformaId: "00000000-0000-4000-8000-000000000001", data: "2027-02-31" }],
    ["duração abaixo de 15 min", { plataformaId: "00000000-0000-4000-8000-000000000001", data: DIA, duracaoMinutos: 5 }],
    ["limiteDias acima de 30", { plataformaId: "00000000-0000-4000-8000-000000000001", data: DIA, limiteDias: 31 }],
  ])("%s → 422", async (_rotulo, params) => {
    const response = await proximo(params as Record<string, string | number>);
    expect(response.statusCode).toBe(422);
    expect(response.json().erro).toBe("Parâmetros inválidos.");
  });

  it("plataforma inexistente → 404", async () => {
    const response = await proximo({ plataformaId: "00000000-0000-4000-8000-000000000000", data: DIA });
    expect(response.statusCode).toBe(404);
  });

  it("plataforma em manutenção ou inativa → encontrado:false", async () => {
    for (const id of [p2Manutencao, p3Inativa]) {
      const response = await proximo({ plataformaId: id, data: DIA });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ encontrado: false, data: null, inicioMin: null, fimMin: null });
    }
  });

  it("ignora 'concluida' e 'cancelada': a primeira folga é a hora concluída, no início do expediente", async () => {
    const response = await proximo({ plataformaId: p1, data: D2, duracaoMinutos: 60, limiteDias: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ encontrado: true, data: D2, inicioMin: ini, fimMin: ini + 60 });
  });

  it("pula reserva agendada, reserva cancelada (ignorada) e bloqueio global, até o vão que comporta a duração", async () => {
    // 120 min: [ini,ini+60) é curto; [ini+180,ini+240) é curto (e o bloqueio começa em ini+240);
    // o primeiro vão de verdade começa depois do bloqueio, em ini+300.
    const response = await proximo({ plataformaId: p1, data: D2, duracaoMinutos: 120, limiteDias: 1 });
    expect(response.json()).toEqual({ encontrado: true, data: D2, inicioMin: ini + 300, fimMin: ini + 420 });
  });

  it("nunca ultrapassa a duração máxima: pedir mais que o máximo não tem resposta", async () => {
    const response = await proximo({ plataformaId: p1, data: D2, duracaoMinutos: 24 * 60, limiteDias: 3 });
    expect(response.statusCode).toBe(200);
    expect(response.json().encontrado).toBe(false);
  });

  it("dia inteiro bloqueado: limiteDias=1 não acha; com mais dias acha em um dia posterior", async () => {
    const curto = await proximo({ plataformaId: p1, data: D3, duracaoMinutos: 60, limiteDias: 1 });
    expect(curto.json().encontrado).toBe(false);

    const longo = await proximo({ plataformaId: p1, data: D3, duracaoMinutos: 60, limiteDias: 3 });
    expect(longo.json()).toMatchObject({ encontrado: true, data: somarDias(D3, 1), inicioMin: ini });
  });

  it("'em_uso' ocupa horário; 'pendente' não (a primeira folga cai sobre a solicitação pendente)", async () => {
    const response = await proximo({ plataformaId: p1, data: D4, duracaoMinutos: 60, limiteDias: 1 });
    expect(response.json()).toEqual({ encontrado: true, data: D4, inicioMin: ini, fimMin: ini + 60 });
  });

  it("o resultado é sempre um horário que POST /reservas aceitaria (não invade nada e cabe no expediente)", async () => {
    const response = await proximo({ plataformaId: p1, data: DIA, duracaoMinutos: 90, limiteDias: 5 });
    const achado = response.json() as ProximoResposta;
    expect(achado.encontrado).toBe(true);
    expect(achado.inicioMin!).toBeGreaterThanOrEqual(ini);
    expect(achado.fimMin!).toBeLessThanOrEqual(fim);
    expect(achado.fimMin! - achado.inicioMin!).toBe(90);

    // Confere contra a própria consulta agregada do dia encontrado.
    const [plataforma] = (await disponibilidade(achado.data!, colabTi, p1)).plataformas;
    for (const ocupado of plataforma.intervalos) {
      if (ocupado.status === "concluida") continue;
      const sobrepoe = !(achado.fimMin! <= ocupado.inicioMin || achado.inicioMin! >= ocupado.fimMin);
      expect(sobrepoe, `sobrepõe ${ocupado.tipo} ${ocupado.inicioMin}-${ocupado.fimMin}`).toBe(false);
    }
  });
});
