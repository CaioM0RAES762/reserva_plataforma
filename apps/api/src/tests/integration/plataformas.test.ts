import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_COLABORADOR = "teste.plataformas.colaborador@metalsider.com.br";
const SENHA_COLABORADOR = "SenhaForte123";
const CODIGO_TESTE = "PLT-S2-TESTE";

let app: FastifyInstance;
let colaboradorId: string;
let cookieAdmin: string;
let cookieColaborador: string;
let plataformaId: string;

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
  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .query("DELETE FROM Usuario WHERE email = @email");
  await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_TESTE)
    .query("DELETE FROM Plataforma WHERE codigo = @codigo");

  const senhaHash = await hashPassword(SENHA_COLABORADOR);
  const insercao = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador de Teste S2")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("perfil", sql.VarChar, "colaborador")
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, @perfil, NULL, 1, 1)`
    );
  colaboradorId = insercao.recordset[0].id;

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
    payload: { email: EMAIL_COLABORADOR, senha: SENHA_COLABORADOR },
  });
  expect(loginColaborador.statusCode).toBe(200);
  cookieColaborador = extrairCookieToken(loginColaborador.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  const pool = await getPool();
  if (plataformaId) {
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, plataformaId)
      .query("DELETE FROM LogAuditoria WHERE entidade_id = @id");
    await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
  }
  await pool.request().input("id", sql.UniqueIdentifier, colaboradorId).query("DELETE FROM LogAuditoria WHERE usuario_id = @id");
  await pool.request().input("id", sql.UniqueIdentifier, colaboradorId).query("DELETE FROM Usuario WHERE id = @id");
  await app.close();
  await closePool();
});

describe("CRUD de Plataforma (S2)", () => {
  it("Colaborador não pode criar plataforma (403)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieColaborador },
      payload: { codigo: CODIGO_TESTE, nome: "Não deveria criar", localizacao: "N/A" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin cria plataforma com sucesso (201)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieAdmin },
      payload: {
        codigo: CODIGO_TESTE,
        nome: "Plataforma de Teste S2",
        localizacao: "Galpão de Testes",
        capacidade: 500,
        observacoes: "Criada por teste de integração.",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.codigo).toBe(CODIGO_TESTE);
    expect(body.status).toBe("disponivel");
    plataformaId = body.id;
  });

  it("Admin não consegue criar segunda plataforma com o mesmo código (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieAdmin },
      payload: { codigo: CODIGO_TESTE.toLowerCase(), nome: "Duplicata", localizacao: "N/A" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("GET /plataformas reflete o registro criado", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/plataformas?q=${encodeURIComponent(CODIGO_TESTE)}`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; codigo: string }>;
    expect(body.some((p) => p.id === plataformaId && p.codigo === CODIGO_TESTE)).toBe(true);
  });

  it("PATCH /status altera status corretamente (disponivel -> manutencao)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/plataformas/${plataformaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { status: "manutencao" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("manutencao");

    const confirmacao = await app.inject({
      method: "GET",
      url: `/api/v1/plataformas?q=${encodeURIComponent(CODIGO_TESTE)}`,
      headers: { cookie: cookieAdmin },
    });
    const encontrada = confirmacao.json().find((p: { id: string }) => p.id === plataformaId);
    expect(encontrada.status).toBe("manutencao");
  });

  it("Colaborador não pode alterar status (403)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/plataformas/${plataformaId}/status`,
      headers: { cookie: cookieColaborador },
      payload: { status: "disponivel" },
    });
    expect(response.statusCode).toBe(403);
  });
});
