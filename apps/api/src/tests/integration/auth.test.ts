import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_TESTE = "teste.integracao@metalsider.com.br";
const CODIGO_TESTE = "482913";
const SENHA_NOVA = "SenhaForte123";

let app: FastifyInstance;
let usuarioId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL_TESTE)
    .query("DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = @email)");
  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL_TESTE)
    .query("DELETE FROM Usuario WHERE email = @email");

  const senhaPlaceholder = await hashPassword("placeholder-nao-utilizavel");

  const insertUsuario = await pool
    .request()
    .input("nome", sql.NVarChar, "Usuário de Teste")
    .input("email", sql.NVarChar, EMAIL_TESTE)
    .input("senha_hash", sql.VarChar, senhaPlaceholder)
    .input("perfil", sql.VarChar, "colaborador")
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, @perfil, NULL, 1, 0)`
    );
  usuarioId = insertUsuario.recordset[0].id;

  const expiraEm = new Date(Date.now() + 15 * 60 * 1000);
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("codigo", sql.Char(6), CODIGO_TESTE)
    .input("tipo", sql.VarChar, "ativacao_conta")
    .input("expira_em", sql.DateTime2, expiraEm)
    .query(
      `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
       VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
    );
});

afterAll(async () => {
  const pool = await getPool();
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .query("DELETE FROM CodigoVerificacao WHERE usuario_id = @usuario_id");
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .query("DELETE FROM LogAuditoria WHERE usuario_id = @usuario_id");
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, usuarioId)
    .query("DELETE FROM Usuario WHERE id = @id");
  await app.close();
  await closePool();
});

describe("Fluxo de autenticação ponta-a-ponta", () => {
  it("1) login antes da ativação retorna erro", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL_TESTE, senha: "placeholder-nao-utilizavel" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().erro).toMatch(/não ativada/i);
  });

  it("2) ativar-conta com código correto define senha e ativa a conta", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_TESTE, codigo: CODIGO_TESTE, senha: SENHA_NOVA },
    });
    expect(response.statusCode).toBe(200);
  });

  it("3) login após ativação retorna sucesso com JWT", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL_TESTE, senha: SENHA_NOVA },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".")).toHaveLength(3);
    expect(response.cookies.some((c) => c.name === "token")).toBe(true);
  });

  it("código de ativação já utilizado é rejeitado numa segunda tentativa", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_TESTE, codigo: CODIGO_TESTE, senha: SENHA_NOVA },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().erro).toMatch(/já utilizado/i);
  });
});
