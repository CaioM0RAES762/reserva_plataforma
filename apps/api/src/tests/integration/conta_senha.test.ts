import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { closePool, getPool, sql } from "../../db/pool.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";

const EMAIL = "teste.troca.senha@metalsider.com.br";
const SENHA_PROVISORIA = "metal@40";
const NOVA_SENHA_VALIDA = "metal@10";

let app: FastifyInstance;
let usuarioId: string;
let cookie: string;
let hashOriginal: string;

function extrairCookieToken(cookies: Array<{ name: string; value: string }>): string {
  const token = cookies.find((item) => item.name === "token");
  if (!token) throw new Error("Cookie de sessão não encontrado.");
  return `${token.name}=${token.value}`;
}

async function restaurarSenhaProvisoria(): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, usuarioId)
    .input("senha_hash", sql.VarChar, hashOriginal)
    .query("UPDATE Usuario SET senha_hash = @senha_hash, senha_provisoria = 1 WHERE id = @id");
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();
  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL)
    .query("DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = @email)");
  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL)
    .query("DELETE FROM Usuario WHERE email = @email");

  hashOriginal = await hashPassword(SENHA_PROVISORIA);
  const usuario = await pool
    .request()
    .input("nome", sql.NVarChar, "Teste Troca Obrigatória")
    .input("email", sql.NVarChar, EMAIL)
    .input("senha_hash", sql.VarChar, hashOriginal)
    .query<{ id: string }>(
      `INSERT INTO Usuario
         (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado, senha_provisoria)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', NULL, 1, 1, 1)`
    );
  usuarioId = usuario.recordset[0].id;

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL, senha: SENHA_PROVISORIA },
  });
  expect(login.statusCode).toBe(200);
  cookie = extrairCookieToken(login.cookies);
});

afterAll(async () => {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, usuarioId)
    .query("DELETE FROM LogAuditoria WHERE usuario_id = @id");
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, usuarioId)
    .query("DELETE FROM Usuario WHERE id = @id");
  await app.close();
  await closePool();
});

describe("PATCH /api/v1/conta/senha", () => {
  it("rejeita senha atual incorreta com mensagem específica", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie },
      payload: { senhaAtual: "metal@10", novaSenha: "OutraSenha@123" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().erro).toBe("Senha atual incorreta.");
  });

  it("rejeita a mesma senha atual com a mensagem de igualdade", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie },
      payload: { senhaAtual: SENHA_PROVISORIA, novaSenha: SENHA_PROVISORIA },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().erro).toBe("A nova senha deve ser diferente da senha atual.");
  });

  it.each([
    ["metal@1", "A senha deve ter no mínimo 8 caracteres"],
    ["metal@2", "A senha deve ter no mínimo 8 caracteres"],
  ])("rejeita %s somente por não atingir o tamanho mínimo", async (novaSenha, mensagemEsperada) => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie },
      payload: { senhaAtual: SENHA_PROVISORIA, novaSenha },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().erro).toBe(mensagemEsperada);
    expect(response.json().erro).not.toBe("Dados inválidos.");
  });

  it.each([
    "metal@10",
    "metal@20",
    "metal@41",
    "metal@100",
    "metal@123",
    "metal@1234",
    "metal@9999",
    "metal@99999",
    "metal@123456",
    "metal@999999",
  ])("aceita %s sem exigir letra maiúscula", async (novaSenha) => {
    await restaurarSenhaProvisoria();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie },
      payload: { senhaAtual: SENHA_PROVISORIA, novaSenha },
    });

    expect(response.statusCode).toBe(200);
  });

  it("troca por uma senha válida, atualiza o hash e encerra o estado provisório", async () => {
    await restaurarSenhaProvisoria();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie },
      payload: { senhaAtual: SENHA_PROVISORIA, novaSenha: NOVA_SENHA_VALIDA },
    });
    expect(response.statusCode).toBe(200);

    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("id", sql.UniqueIdentifier, usuarioId)
      .query<{ senha_hash: string; senha_provisoria: boolean }>(
        "SELECT senha_hash, senha_provisoria FROM Usuario WHERE id = @id"
      );
    const usuario = resultado.recordset[0];

    expect(usuario.senha_hash).not.toBe(hashOriginal);
    expect(await verifyPassword(SENHA_PROVISORIA, usuario.senha_hash)).toBe(false);
    expect(await verifyPassword(NOVA_SENHA_VALIDA, usuario.senha_hash)).toBe(true);
    expect(Boolean(usuario.senha_provisoria)).toBe(false);

    const loginAntigo = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL, senha: SENHA_PROVISORIA },
    });
    expect(loginAntigo.statusCode).toBe(401);

    const loginNovo = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL, senha: NOVA_SENHA_VALIDA },
    });
    expect(loginNovo.statusCode).toBe(200);

    const conta = await app.inject({
      method: "GET",
      url: "/api/v1/conta",
      headers: { cookie: extrairCookieToken(loginNovo.cookies) },
    });
    expect(conta.statusCode).toBe(200);
    expect(conta.json().senhaProvisoria).toBe(false);
  });
});
