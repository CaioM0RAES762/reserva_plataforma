import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_COLABORADOR_TI = "teste.historico.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.historico.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA_A = "PLT-S5-A";
const CODIGO_PLATAFORMA_B = "PLT-S5-B";
const DATA_TI = "2026-10-05";
const DATA_MANUTENCAO = "2026-10-12";

let app: FastifyInstance;
let setorTiId: string;
let setorManutencaoId: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;
let plataformaAId: string;
let plataformaBId: string;
let cookieColaboradorTi: string;
let cookieColaboradorManutencao: string;
let cookieAdmin: string;
let reservaTiId: string;
let reservaManutencaoId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_A}', '${CODIGO_PLATAFORMA_B}')))`
  );
  await pool
    .request()
    .query(
      `DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_A}', '${CODIGO_PLATAFORMA_B}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_A}', '${CODIGO_PLATAFORMA_B}')`);
  await pool
    .request()
    .query(
      `DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}')`
    );

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  setorManutencaoId = setorManutencao.recordset[0].id;

  const plataformaA = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_A)
    .input("nome", sql.NVarChar, "Plataforma Histórico A")
    .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
  plataformaAId = plataformaA.recordset[0].id;

  const plataformaB = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_B)
    .input("nome", sql.NVarChar, "Plataforma Histórico B")
    .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
  plataformaBId = plataformaB.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste S5")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_TI)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorTiId = colaboradorTi.recordset[0].id;

  const colaboradorManutencao = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste S5")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_MANUTENCAO)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorManutencaoId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorManutencaoId = colaboradorManutencao.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginTi = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_TI, senha: SENHA },
  });
  expect(loginTi.statusCode).toBe(200);
  cookieColaboradorTi = extrairCookieToken(loginTi.cookies.map((c) => `${c.name}=${c.value}`));

  const loginManutencao = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_MANUTENCAO, senha: SENHA },
  });
  expect(loginManutencao.statusCode).toBe(200);
  cookieColaboradorManutencao = extrairCookieToken(
    loginManutencao.cookies.map((c) => `${c.name}=${c.value}`)
  );

  // Reserva do setor TI, plataforma A — permanece "pendente".
  const criacaoTi = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorTi },
    payload: {
      plataformaId: plataformaAId,
      data: DATA_TI,
      horaInicio: "08:00",
      horaFim: "09:00",
      motivo: "Inspeção elétrica programada no painel principal",
      prioridade: "normal",
    },
  });
  expect(criacaoTi.statusCode).toBe(201);
  reservaTiId = criacaoTi.json().id;

  // Reserva do setor Manutenção, plataforma B — aprovada, vira "agendada".
  const criacaoManutencao = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorManutencao },
    payload: {
      plataformaId: plataformaBId,
      data: DATA_MANUTENCAO,
      horaInicio: "14:00",
      horaFim: "15:00",
      motivo: "Troca de peças hidráulicas na plataforma",
      prioridade: "alta",
    },
  });
  expect(criacaoManutencao.statusCode).toBe(201);
  reservaManutencaoId = criacaoManutencao.json().id;

  const aprovacao = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaManutencaoId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacao.statusCode).toBe(200);
});

afterAll(async () => {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaAId}', '${plataformaBId}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN ('${plataformaAId}', '${plataformaBId}')`);
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE id IN ('${plataformaAId}', '${plataformaBId}')`);
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`
    );
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`);
  await app.close();
  await closePool();
});

describe("Histórico (S5) — filtros isolados", () => {
  it("filtro de texto (q) encontra pela plataforma", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico?q=Histórico+A",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaTiId)).toBe(true);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
  });

  it("filtro de texto (q) encontra pelo motivo", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico?q=hidráulicas",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(true);
    expect(body.some((r) => r.id === reservaTiId)).toBe(false);
  });

  it("filtro de setor (Admin) restringe ao setor informado", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico?setor=${setorTiId}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaTiId)).toBe(true);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
  });

  it("filtro de plataforma restringe à plataforma informada", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico?plataforma=${plataformaBId}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(true);
    expect(body.some((r) => r.id === reservaTiId)).toBe(false);
  });

  it("filtro de status restringe ao status informado", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico?status=agendada",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; status: string }>;
    expect(body.every((r) => r.status === "agendada")).toBe(true);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(true);
    expect(body.some((r) => r.id === reservaTiId)).toBe(false);
  });

  it("filtro dateFrom/dateTo restringe ao intervalo informado", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico?dateFrom=2026-10-01&dateTo=2026-10-08",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaTiId)).toBe(true);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
  });
});

describe("Histórico (S5) — filtros combinados", () => {
  it("setor + status combinados retornam apenas a interseção", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico?setor=${setorManutencaoId}&status=agendada`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(true);
    expect(body.some((r) => r.id === reservaTiId)).toBe(false);
  });

  it("setor + status sem interseção retorna lista vazia", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico?setor=${setorTiId}&status=agendada`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaTiId)).toBe(false);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
  });
});

describe("Histórico (S5) — escopo por setor do Colaborador", () => {
  it("Colaborador só vê registros do próprio setor por padrão", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaTiId)).toBe(true);
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
  });

  it("Colaborador forçando ?setor=<outro setor> na query continua restrito ao próprio setor", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico?setor=${setorManutencaoId}`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaManutencaoId)).toBe(false);
    expect(body.some((r) => r.id === reservaTiId)).toBe(true);
  });
});

describe("Histórico (S5) — exportação CSV", () => {
  it("GET /historico/export retorna CSV com BOM UTF-8 e separador ;", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/historico/export?plataforma=${plataformaAId}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    const corpo = response.body;
    expect(corpo.charCodeAt(0)).toBe(0xfeff);
    expect(corpo).toContain("ID;Criada em;Setor;Responsável;Plataforma;Data;Início;Fim;Prioridade;Status;Motivo");
    expect(corpo).toContain("Inspeção elétrica programada");
  });
});
