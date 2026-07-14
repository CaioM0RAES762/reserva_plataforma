import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S12 — RF-SET-01/02: CRUD completo de setores. Gate de Aceite: tentar desativar um
// setor com usuário ativo vinculado deve ser rejeitado (RN-USR-02).

const EMAIL_COLABORADOR = "teste.s12.setor.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const NOME_SETOR = "Setor de Teste S12";
const NOME_SETOR_EDITADO = "Setor de Teste S12 (editado)";

let app: FastifyInstance;
let setorId: string;
let colaboradorId: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);
  await pool.request().query(`DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Setor WHERE nome IN ('${NOME_SETOR}', '${NOME_SETOR_EDITADO}'))`);
  await pool.request().query(`DELETE FROM Setor WHERE nome IN ('${NOME_SETOR}', '${NOME_SETOR_EDITADO}')`);

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  const pool = await getPool();
  if (colaboradorId) {
    await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorId}'`);
    await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorId}'`);
  }
  if (setorId) {
    await pool.request().query(`DELETE FROM LogAuditoria WHERE entidade_id = '${setorId}'`);
    await pool.request().input("id", sql.UniqueIdentifier, setorId).query("DELETE FROM Setor WHERE id = @id");
  }
  await app.close();
  await closePool();
});

describe("CRUD de Setores (S12 — RF-SET-01)", () => {
  it("Requisição sem sessão não pode criar setor (401)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setores",
      payload: { nome: NOME_SETOR, corHex: "#2563EB" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("Admin cria setor com sucesso (201)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setores",
      headers: { cookie: cookieAdmin },
      payload: { nome: NOME_SETOR, corHex: "#2563EB" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.nome).toBe(NOME_SETOR);
    expect(body.ativo).toBe(true);
    setorId = body.id;
  });

  it("Admin não consegue criar setor duplicado (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setores",
      headers: { cookie: cookieAdmin },
      payload: { nome: NOME_SETOR, corHex: "#16A34A" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("GET /setores/admin reflete o setor criado, incluindo status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setores/admin",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const encontrado = response.json().find((s: { id: string }) => s.id === setorId);
    expect(encontrado).toBeTruthy();
    expect(encontrado.ativo).toBe(true);
  });

  it("Admin edita o setor (nome e cor)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/setores/${setorId}`,
      headers: { cookie: cookieAdmin },
      payload: { nome: NOME_SETOR_EDITADO, corHex: "#D97706" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().nome).toBe(NOME_SETOR_EDITADO);
  });

  it("GATE S12 (RN-USR-02) — vincula um usuário ativo ao setor", async () => {
    const senhaHash = await hashPassword(SENHA);
    const pool = await getPool();
    const insercao = await pool
      .request()
      .input("nome", sql.NVarChar, "Colaborador Teste S12 Setor")
      .input("email", sql.NVarChar, EMAIL_COLABORADOR)
      .input("senha_hash", sql.VarChar, senhaHash)
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .query<{ id: string }>(
        `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
         OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
      );
    colaboradorId = insercao.recordset[0].id;
    expect(colaboradorId).toBeTruthy();
  });

  it("GATE S12 (RN-USR-02) — tentar desativar setor com usuário ativo vinculado é rejeitado (409)", async () => {
    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S12 — PATCH /setores/:id/status (ativo:false) com usuário ativo vinculado ===");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/setores/${setorId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { ativo: false },
    });
    // eslint-disable-next-line no-console
    console.log({ statusCode: response.statusCode, corpo: response.json() });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("RN-USR-02");

    const confirmacao = await getPool().then((pool) =>
      pool.request().input("id", sql.UniqueIdentifier, setorId).query<{ ativo: boolean }>("SELECT ativo FROM Setor WHERE id = @id")
    );
    expect(confirmacao.recordset[0].ativo).toBe(true);
  });

  it("Após desativar o usuário vinculado, a desativação do setor é permitida (200)", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/usuarios/${colaboradorId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { ativo: false },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/setores/${setorId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { ativo: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ativo).toBe(false);
  });

  it("PATCH /setores/:id/status grava LogAuditoria (alterar_status_setor)", async () => {
    const pool = await getPool();
    const logs = await pool
      .request()
      .input("id", sql.UniqueIdentifier, setorId)
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM LogAuditoria WHERE entidade = 'Setor' AND entidade_id = @id AND acao = 'alterar_status_setor'"
      );
    expect(logs.recordset[0].total).toBeGreaterThan(0);
  });
});
