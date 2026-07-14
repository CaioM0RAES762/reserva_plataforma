import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S12 — RF-USR-01..04: CRUD completo de usuários (a promoção/rebaixamento de perfil,
// RF-USR-05, já é coberta por testes de S7 em aprovacao_dupla.test.ts e não é repetida
// aqui). Complementa configuracoes.test.ts/setores.test.ts no Gate de Aceite de S12.

const EMAIL_NOVO_USUARIO = "teste.s12.usuario.crud@metalsider.com.br";
const EMAIL_EDITADO = "teste.s12.usuario.crud.editado@metalsider.com.br";
const EMAIL_COLABORADOR_RBAC = "teste.s12.usuario.crud.rbac@metalsider.com.br";
const SENHA = "SenhaForte123";

let app: FastifyInstance;
let setorTiId: string;
let novoUsuarioId: string;
let colaboradorRbacId: string;
let cookieAdmin: string;
let cookieColaborador: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_NOVO_USUARIO}', '${EMAIL_EDITADO}', '${EMAIL_COLABORADOR_RBAC}')`);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador RBAC S12")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_RBAC)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorRbacId = colaborador.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginColaborador = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_RBAC, senha: SENHA },
  });
  expect(loginColaborador.statusCode).toBe(200);
  cookieColaborador = extrairCookieToken(loginColaborador.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  const pool = await getPool();
  if (novoUsuarioId) {
    await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${novoUsuarioId}' OR entidade_id = '${novoUsuarioId}'`);
    await pool.request().query(`DELETE FROM CodigoVerificacao WHERE usuario_id = '${novoUsuarioId}'`);
    await pool.request().query(`DELETE FROM Usuario WHERE id = '${novoUsuarioId}'`);
  }
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorRbacId}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorRbacId}'`);
  await app.close();
  await closePool();
});

describe("CRUD de Usuários (S12 — RF-USR-01..04)", () => {
  it("Admin cria usuário colaborador (201) e um código de ativação é gerado", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: {
        nome: "Colaborador CRUD S12",
        email: EMAIL_NOVO_USUARIO,
        perfil: "colaborador",
        setorId: setorTiId,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.email).toBe(EMAIL_NOVO_USUARIO);
    expect(body.ativo).toBe(true);
    expect(body.emailVerificado).toBe(false);
    novoUsuarioId = body.id;

    const pool = await getPool();
    const codigos = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoUsuarioId)
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM CodigoVerificacao WHERE usuario_id = @id AND tipo = 'ativacao_conta'"
      );
    expect(codigos.recordset[0].total).toBe(1);
  });

  it("Admin não consegue criar segundo usuário com o mesmo e-mail (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: { nome: "Duplicata", email: EMAIL_NOVO_USUARIO, perfil: "colaborador", setorId: setorTiId },
    });
    expect(response.statusCode).toBe(409);
  });

  it("GET /usuarios (Admin) reflete o usuário criado e aceita filtro por perfil/setor", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/usuarios?perfil=colaborador&setor=${setorTiId}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().some((u: { id: string }) => u.id === novoUsuarioId)).toBe(true);
  });

  it("Admin edita nome/e-mail do usuário", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/usuarios/${novoUsuarioId}`,
      headers: { cookie: cookieAdmin },
      payload: { nome: "Colaborador CRUD S12 (editado)", email: EMAIL_EDITADO, setorId: setorTiId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().email).toBe(EMAIL_EDITADO);
  });

  it("Admin reenvia código (usuário ainda não ativado -> tipo ativacao_conta)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/usuarios/${novoUsuarioId}/reenviar-codigo`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tipo).toBe("ativacao_conta");
  });

  it("Admin desativa o usuário (soft delete — RF-USR-03)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/usuarios/${novoUsuarioId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { ativo: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ativo).toBe(false);

    const pool = await getPool();
    const confirmacao = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoUsuarioId)
      .query<{ total: number }>("SELECT COUNT(*) AS total FROM Usuario WHERE id = @id");
    // Soft delete: a linha continua existindo (histórico preservado), só ativo muda.
    expect(confirmacao.recordset[0].total).toBe(1);
  });

  it("Admin não pode desativar a própria conta (409)", async () => {
    const contaAdmin = await app.inject({ method: "GET", url: "/api/v1/conta", headers: { cookie: cookieAdmin } });
    const adminId = contaAdmin.json().id;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/usuarios/${adminId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { ativo: false },
    });
    expect(response.statusCode).toBe(409);
  });

  it("Colaborador não acessa GET /usuarios nem POST /usuarios (403)", async () => {
    const listagem = await app.inject({
      method: "GET",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieColaborador },
    });
    expect(listagem.statusCode).toBe(403);

    const criacao = await app.inject({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieColaborador },
      payload: { nome: "Não deveria criar", email: "outro@metalsider.com.br", perfil: "colaborador", setorId: setorTiId },
    });
    expect(criacao.statusCode).toBe(403);
  });

  it("Requisição sem sessão não acessa GET /usuarios (401)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/usuarios" });
    expect(response.statusCode).toBe(401);
  });
});
