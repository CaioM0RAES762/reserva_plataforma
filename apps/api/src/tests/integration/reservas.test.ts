import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_COLABORADOR_TI = "teste.reservas.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.reservas.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S3-TESTE";
const DATA_RESERVA = "2026-08-10";

let app: FastifyInstance;
let setorTiId: string;
let setorManutencaoId: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;
let plataformaId: string;
let cookieColaboradorTi: string;
let cookieColaboradorManutencao: string;
let cookieAdmin: string;
let reservaAId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  // Limpeza defensiva de execuções anteriores que tenham falhado no meio do caminho.
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(
      `DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}')`
    );

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  setorManutencaoId = setorManutencao.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S3")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste S3")
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
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste S3")
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
});

afterAll(async () => {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id = '${plataformaId}')`
    );
  await pool.request().query(`DELETE FROM Reserva WHERE plataforma_id = '${plataformaId}'`);
  await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
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

describe("Reservas (S3) — criação, conflito e escopo por setor", () => {
  it("Colaborador cria reserva A com sucesso (201, status pendente)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "10:00",
        motivo: "Manutenção preventiva do equipamento",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("pendente");
    expect(body.setorId).toBe(setorTiId);
    reservaAId = body.id;
  });

  it("GET /reservas reflete a reserva A criada", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaAId)).toBe(true);
  });

  it("Admin sem setor não pode criar reserva (422)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "11:00",
        horaFim: "12:00",
        motivo: "Teste sem setor",
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it("GET /reservas/conflitos detecta conflito com a reserva A para um horário sobreposto", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/conflitos?plataformaId=${plataformaId}&data=${DATA_RESERVA}&horaInicio=09:00&horaFim=11:00`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.conflito).toBe(true);
    expect(body.reserva.id).toBe(reservaAId);
  });

  it("POST /reservas rejeita reserva B conflitante na mesma plataforma/data (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "09:00",
        horaFim: "11:00",
        motivo: "Reserva conflitante — não deveria ser criada",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("Conflito de horário");
  });

  it("POST /reservas aceita reserva adjacente exata (início == fim da reserva A) — SEM conflito", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "10:00",
        horaFim: "11:30",
        motivo: "Reserva adjacente, sem sobreposição real",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("Colaborador de outro setor (Manutenção) não vê a reserva A na listagem (escopo por setor)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaAId)).toBe(false);
  });

  it("Admin vê a reserva A mesmo sem pertencer ao setor TI", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas?data=${DATA_RESERVA}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaAId)).toBe(true);
  });
});
