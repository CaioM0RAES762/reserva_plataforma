import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../../app.js");
const { closePool, getPool, sql } = await import("../../db/pool.js");
const { combinarDataHoraBrasilia } = await import("@plataformares/shared");
const { invalidarCacheConfiguracao } = await import("../../services/configuracao.service.js");
const { processarAutomacaoReservas } = await import("../../services/automacaoReserva.service.js");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* Reserva de vários dias (migration 0029), de ponta a ponta pela API real: criação até a
 * duração máxima, conflitos no primeiro/meio/último dia, adjacência, filtros por sobreposição,
 * grade do dia, recorrência, bloqueio de vários dias, substituição urgente, automação (início e
 * fim completos) e horímetro. Datas relativas e longe no futuro: nada colide com dados reais. */

const PREFIXOS = { plataforma: "PLT-VDIAS", email: "teste.vdias.", bloqueio: "VDIAS" };

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let setor: Setor;
let admin: Usuario;
let colaborador: Usuario;
let p1: string;
let p2: string;
let p3: string;
let duracaoOriginal: string;

// Semana de referência: D0 08:00 → D7 10:00 (170h) em p1.
const D0 = dataFuturaAleatoria();
const D = (n: number) => somarDias(D0, n);

function req(usuario: Usuario, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, payload, headers: { cookie: usuario.cookie } });
}

const base = () => ({ quantidadePessoas: 1, motivo: "Teste vários dias", telefoneContato: "31999999999", setorId: setor.id });

function criar(plataformaId: string, periodo: Record<string, unknown>, usuario: Usuario = admin) {
  return req(usuario, "POST", "/api/v1/reservas", { ...base(), plataformaId, ...periodo });
}

async function conflito(periodo: Record<string, string>) {
  const r = await req(admin, "GET", `/api/v1/reservas/conflitos?${new URLSearchParams({ plataformaId: p1, ...periodo })}`);
  return r.json() as { conflito: boolean; reserva: { dataFim: string } | null };
}

let semanaId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  setor = await garantirSetor("Manutenção");
  admin = await criarUsuarioTeste({ email: `${PREFIXOS.email}admin@metalsider.com.br`, nome: "Admin (vdias)", perfil: "admin", setorId: setor.id });
  colaborador = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab@metalsider.com.br`, nome: "Colab (vdias)", perfil: "colaborador", setorId: setor.id });
  p1 = await criarPlataformaTeste({ codigo: `${PREFIXOS.plataforma}-1`, nome: "Plataforma vários dias 1" });
  p2 = await criarPlataformaTeste({ codigo: `${PREFIXOS.plataforma}-2`, nome: "Plataforma vários dias 2" });
  p3 = await criarPlataformaTeste({ codigo: `${PREFIXOS.plataforma}-3`, nome: "Plataforma vários dias 3" });

  // Regras da suíte: duração máxima de 720h e expediente do dia inteiro; restauradas no fim.
  const pool = await getPool();
  duracaoOriginal = (await pool.request().query("SELECT valor FROM ConfiguracaoSistema WHERE chave = 'duracao_maxima_horas'")).recordset[0].valor;
  await pool.request().query("UPDATE ConfiguracaoSistema SET valor = '720' WHERE chave = 'duracao_maxima_horas'");
  invalidarCacheConfiguracao();
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().input("v", sql.NVarChar, duracaoOriginal).query("UPDATE ConfiguracaoSistema SET valor = @v WHERE chave = 'duracao_maxima_horas'");
  invalidarCacheConfiguracao();
  await pool.request().query(`DELETE FROM BloqueioAgenda WHERE motivo LIKE '${PREFIXOS.bloqueio}%'`);
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setor);
  await app.close();
  await closePool();
});

describe("criação de reserva de vários dias", () => {
  it("cria 170h com dataFim na resposta", async () => {
    const r = await criar(p1, { data: D(0), dataFim: D(7), horaInicio: "08:00", horaFim: "10:00" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ data: D(0), dataFim: D(7), horaInicio: "08:00", horaFim: "10:00" });
    semanaId = r.json().id;
  });

  it("aceita exatamente 720h e recusa 721h", async () => {
    expect((await criar(p2, { data: D(40), dataFim: D(70), horaInicio: "08:00", horaFim: "08:00" })).statusCode).toBe(201);
    const excedida = await criar(p2, { data: D(80), dataFim: D(110), horaInicio: "08:00", horaFim: "09:00" });
    expect(excedida.statusCode).toBe(409);
    expect(excedida.json().erro).toContain("720");
  });

  it("recusa data final anterior e fim igual ao início", async () => {
    expect((await criar(p2, { data: D(120), dataFim: D(119), horaInicio: "08:00", horaFim: "09:00" })).statusCode).toBe(422);
    expect((await criar(p2, { data: D(120), horaInicio: "08:00", horaFim: "08:00" })).statusCode).toBe(422);
  });

  it("atravessa a meia-noite e mantém a reserva de um dia sem dataFim", async () => {
    expect((await criar(p2, { data: D(121), dataFim: D(122), horaInicio: "22:00", horaFim: "06:00" })).statusCode).toBe(201);
    const dia = await criar(p2, { data: D(123), horaInicio: "08:00", horaFim: "09:00" });
    expect(dia.statusCode).toBe(201);
    expect(dia.json().dataFim).toBe(D(123));
  });
});

describe("conflitos pelo período completo [início, fim)", () => {
  it.each([
    ["no primeiro dia", { data: D(0), horaInicio: "09:00", horaFim: "10:00" }],
    ["no meio", { data: D(3), horaInicio: "02:00", horaFim: "03:00" }],
    ["no último dia", { data: D(7), horaInicio: "09:00", horaFim: "11:00" }],
    ["envolvendo a semana", { data: D(-1), dataFim: D(8), horaInicio: "00:00", horaFim: "00:00" }],
  ])("detecta conflito %s", async (_rotulo, periodo) => {
    const r = await conflito(periodo as Record<string, string>);
    expect(r.conflito).toBe(true);
    expect(r.reserva?.dataFim).toBe(D(7));
  });

  it("adjacência exata no início e no fim não conflita", async () => {
    expect((await conflito({ data: D(7), horaInicio: "10:00", horaFim: "12:00" })).conflito).toBe(false);
    expect((await conflito({ data: D(-1), dataFim: D(0), horaInicio: "20:00", horaFim: "08:00" })).conflito).toBe(false);
  });

  it("criação sobreposta no meio é recusada", async () => {
    expect((await criar(p1, { data: D(4), horaInicio: "08:00", horaFim: "09:00" })).statusCode).toBe(409);
  });
});

describe("leituras por sobreposição", () => {
  const ids = async (q: string) => ((await req(admin, "GET", `/api/v1/reservas?${q}`)).json() as Array<{ id: string }>).map((r) => r.id);

  it("filtros de dia e de intervalo encontram a reserva que começou antes", async () => {
    expect(await ids(`data=${D(3)}`)).toContain(semanaId);
    expect(await ids(`dateFrom=${D(4)}&dateTo=${D(5)}`)).toContain(semanaId);
    expect(await ids(`dateFrom=${D(8)}&dateTo=${D(9)}`)).not.toContain(semanaId);
  });

  it("grade do dia do meio mostra 0–1440 com o período completo", async () => {
    const grade = (await req(admin, "GET", `/api/v1/disponibilidade?data=${D(3)}&plataformaId=${p1}`)).json();
    const intervalo = grade.plataformas[0].intervalos.find((i: { id: string }) => i.id === semanaId);
    expect(intervalo).toMatchObject({ inicioMin: 0, fimMin: 1440, continuaAntes: true, continuaDepois: true });
    expect(intervalo.periodo).toEqual({ data: D(0), dataFim: D(7), horaInicio: "08:00", horaFim: "10:00" });
  });

  it("utilização do relatório recorta o período ao intervalo consultado", async () => {
    const r = await req(admin, "GET", `/api/v1/relatorios/utilizacao?dateFrom=${D(3)}&dateTo=${D(3)}`);
    expect(r.statusCode).toBe(200);
    const linha = r.json().plataformas.find((p: { plataformaId: string }) => p.plataformaId.toLowerCase() === p1.toLowerCase());
    expect(linha.horasReservadas).toBe(24);
  });
});

describe("recorrência semanal", () => {
  it("série de 2 dias desloca início e fim de cada ocorrência", async () => {
    const r = await criar(p3, { data: D(200), dataFim: D(202), horaInicio: "08:00", horaFim: "17:00", recorrencia: { quantidadeOcorrencias: 3 } });
    expect(r.statusCode).toBe(201);
    expect(r.json().reservas.map((x: { dataFim: string }) => x.dataFim)).toEqual([D(202), D(209), D(216)]);
  });

  it("recusa série com 7 dias ou mais de duração", async () => {
    const r = await criar(p3, { data: D(230), dataFim: D(237), horaInicio: "08:00", horaFim: "08:00", recorrencia: { quantidadeOcorrencias: 2 } });
    expect(r.statusCode).toBe(422);
  });

  it("série com uma ocorrência em conflito não grava nada", async () => {
    const r = await criar(p1, { data: D(-7), dataFim: D(-6), horaInicio: "08:00", horaFim: "08:00", recorrencia: { quantidadeOcorrencias: 2 } });
    expect(r.statusCode).toBe(409);
    const pool = await getPool();
    const gravadas = await pool.request().input("p", sql.UniqueIdentifier, p1).input("d", sql.Date, D(-7)).query("SELECT COUNT(*) AS n FROM Reserva WHERE plataforma_id = @p AND data = @d");
    expect(gravadas.recordset[0].n).toBe(0);
  });
});

describe("bloqueio de agenda de vários dias", () => {
  it("pede confirmação quando cobre parte da reserva longa", async () => {
    const r = await req(admin, "POST", "/api/v1/bloqueios", {
      plataformaId: p1,
      dataInicio: `${D(5)}T00:00`,
      dataFim: `${D(6)}T12:00`,
      motivo: `${PREFIXOS.bloqueio} manutenção`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().requerConfirmacao).toBe(true);
    expect(r.json().reservasConflitantes[0]).toMatchObject({ id: semanaId, dataFim: D(7) });
  });
});

describe("substituição urgente sobre reserva de vários dias", () => {
  it("analisa, exige confirmação e substitui", async () => {
    const urgenteId = await inserirReservaTeste({
      setorId: setor.id, solicitanteId: colaborador.id, plataformaId: p1,
      data: D(6), dataFim: D(8), horaInicio: "20:00", horaFim: "08:00",
      status: "pendente", prioridade: "urgente", motivo: "Urgente vários dias",
    });
    const analise = (await req(admin, "GET", `/api/v1/reservas/${urgenteId}/analise-aprovacao`)).json();
    expect(analise.conflitos[0]).toMatchObject({ dataFim: D(7) });
    const semConfirmar = await req(admin, "POST", `/api/v1/reservas/${urgenteId}/aprovar`, {});
    expect(semConfirmar.json().codigo).toBe("CONFLITO_SUBSTITUIVEL");
    const aprovada = await req(admin, "POST", `/api/v1/reservas/${urgenteId}/aprovar`, { substituirConflitantes: true });
    expect(aprovada.statusCode).toBe(200);
    const pool = await getPool();
    const antiga = (await pool.request().input("id", sql.UniqueIdentifier, semanaId).query("SELECT status, substituida_por_id FROM Reserva WHERE id = @id")).recordset[0];
    expect(antiga.status).toBe("cancelada");
    expect(antiga.substituida_por_id.toLowerCase()).toBe(urgenteId.toLowerCase());
  });
});

describe("automação e horímetro com período de vários dias", () => {
  it("inicia no instante completo, não conclui na primeira meia-noite e soma 48h ao horímetro", async () => {
    const id = await inserirReservaTeste({
      setorId: setor.id, solicitanteId: admin.id, plataformaId: p3,
      data: D(300), dataFim: D(302), horaInicio: "08:00", horaFim: "08:00", status: "agendada",
    });
    const pool = await getPool();
    const estado = async () =>
      (await pool.request().input("id", sql.UniqueIdentifier, id).query("SELECT status, uso_contabilizado_minutos AS uso FROM Reserva WHERE id = @id")).recordset[0];
    const rodar = (data: string, hora: string) => processarAutomacaoReservas(combinarDataHoraBrasilia(data, hora), { somenteIds: [id] });

    await rodar(D(300), "07:59");
    expect((await estado()).status).toBe("agendada");
    await rodar(D(300), "08:00");
    expect((await estado()).status).toBe("em_uso");
    // O início real é gravado com o relógio do servidor; fixa no instante agendado para medir.
    await pool.request().input("id", sql.UniqueIdentifier, id).input("i", sql.VarChar, `${D(300)}T08:00:00`)
      .query("UPDATE Reserva SET inicio_real_em = CAST(@i AS DATETIME2(0)), hora_inicio_real = '08:00' WHERE id = @id");
    await rodar(D(301), "00:01");
    expect((await estado()).status).toBe("em_uso");
    await rodar(D(302), "08:00");
    expect(await estado()).toEqual({ status: "concluida", uso: 48 * 60 });
  });
});
