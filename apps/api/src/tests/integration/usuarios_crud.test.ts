import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword, verifyPassword, SENHA_INICIAL_PADRAO } from "../../utils/password.js";
import { definirProviderEmailParaTeste } from "../../services/email.service.js";
import { criarProviderMockSempreAceita } from "../helpers/emailProviderMock.js";

// S12 — RF-USR-01..04: CRUD completo de usuários (a promoção/rebaixamento de perfil,
// RF-USR-05, já é coberta por testes de S7 em aprovacao_dupla.test.ts e não é repetida
// aqui). Complementa configuracoes.test.ts/setores.test.ts no Gate de Aceite de S12.
//
// Revisão (fluxo de senha inicial): a criação pelo Admin deixou de enviar código de
// ativação por e-mail — a conta nasce com senha inicial fixa (SENHA_INICIAL_PADRAO,
// hasheada), ativo=1, email_verificado=1 e senha_provisoria=1 (força troca no primeiro
// login, ver PATCH /conta/senha). O autocadastro público (POST /auth/cadastrar) não muda:
// continua usando placeholder aleatório + OTP, coberto em otp_email_flow.test.ts.

const EMAIL_NOVO_USUARIO = "teste.s12.usuario.crud@metalsider.com.br";
const EMAIL_EDITADO = "teste.s12.usuario.crud.editado@metalsider.com.br";
const EMAIL_COLABORADOR_RBAC = "teste.s12.usuario.crud.rbac@metalsider.com.br";
const SENHA = "SenhaForte123";
// Admin próprio deste arquivo — não depende de SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD
// (podem não estar definidas no .env), mesmo padrão do colaborador RBAC acima.
const EMAIL_ADMIN_TESTE = "teste.s12.admin.crud@metalsider.com.br";
const SENHA_ADMIN_TESTE = "SenhaAdminTeste123";

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

  // Criar usuário aqui dispara um envio de e-mail real e bloqueante (ver otp.service.ts) —
  // o mock evita depender de rede/SMTP real e um envio de verdade a cada rodada de testes.
  // O comportamento de envio em si (sucesso, falha, template, purpose) é testado à parte em
  // otp_email_flow.test.ts com asserções explícitas sobre o mock.
  definirProviderEmailParaTeste(criarProviderMockSempreAceita());

  const pool = await getPool();
  // Se uma rodada anterior tiver falhado no meio do afterAll, alguma dessas linhas pode ter
  // ficado órfã com Notificacao/LogAuditoria pendentes — limpar isso primeiro evita que o
  // DELETE de Usuario logo abaixo falhe de novo com erro de FK.
  const EMAILS_USUARIOS_TESTE = `'${EMAIL_NOVO_USUARIO}', '${EMAIL_EDITADO}', '${EMAIL_COLABORADOR_RBAC}', '${EMAIL_ADMIN_TESTE}'`;
  await pool
    .request()
    .query(`DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${EMAILS_USUARIOS_TESTE}))`);
  await pool
    .request()
    .query(`DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${EMAILS_USUARIOS_TESTE}))`);
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${EMAILS_USUARIOS_TESTE})) OR entidade_id IN (SELECT id FROM Usuario WHERE email IN (${EMAILS_USUARIOS_TESTE}))`);
  await pool.request().query(`DELETE FROM Usuario WHERE email IN (${EMAILS_USUARIOS_TESTE})`);

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

  await pool
    .request()
    .input("nome", sql.NVarChar, "Admin de Teste (usuarios_crud)")
    .input("email", sql.NVarChar, EMAIL_ADMIN_TESTE)
    .input("senha_hash", sql.VarChar, await hashPassword(SENHA_ADMIN_TESTE))
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       VALUES (@nome, @email, @senha_hash, 'admin', NULL, 1, 1)`
    );

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_ADMIN_TESTE, senha: SENHA_ADMIN_TESTE },
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
  definirProviderEmailParaTeste(null);
  const pool = await getPool();
  if (novoUsuarioId) {
    await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${novoUsuarioId}' OR entidade_id = '${novoUsuarioId}'`);
    await pool.request().query(`DELETE FROM CodigoVerificacao WHERE usuario_id = '${novoUsuarioId}'`);
    await pool.request().query(`DELETE FROM Usuario WHERE id = '${novoUsuarioId}'`);
  }
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorRbacId}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorRbacId}'`);
  // O admin de teste é ATOR de várias entradas de auditoria geradas durante a suíte (criar/
  // editar usuário etc.) — sem limpar essas referências primeiro, o DELETE do Usuario
  // esbarra em FK_LogAuditoria_Usuario/FK_Notificacao_Usuario.
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_ADMIN_TESTE}')`
    );
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_ADMIN_TESTE}')`
    );
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_ADMIN_TESTE}'`);
  await app.close();
  await closePool();
});

describe("CRUD de Usuários (S12 — RF-USR-01..04)", () => {
  it("Admin cria usuário colaborador (201) com senha inicial fixa, pronto para logar", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: {
        nome: "Colaborador CRUD S12",
        email: EMAIL_NOVO_USUARIO,
        telefone: "31999990000",
        perfil: "colaborador",
        setorId: setorTiId,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.email).toBe(EMAIL_NOVO_USUARIO);
    expect(body.telefone).toBe("31999990000");
    expect(body.ativo).toBe(true);
    // Admin já vouching pelo e-mail — a conta nasce verificada, sem passar por OTP.
    expect(body.emailVerificado).toBe(true);
    expect(body.senhaProvisoria).toBe(true);
    novoUsuarioId = body.id;

    // Nenhum código de ativação é gerado — a senha inicial substitui o fluxo de OTP
    // para contas criadas pelo Admin (o autocadastro público continua usando OTP).
    const pool = await getPool();
    const codigos = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoUsuarioId)
      .query<{ total: number }>("SELECT COUNT(*) AS total FROM CodigoVerificacao WHERE usuario_id = @id");
    expect(codigos.recordset[0].total).toBe(0);

    // A senha gravada é a inicial padrão, hasheada — nunca texto puro (a resposta da API
    // também não devolve o hash nem a senha em nenhum campo, conferido implicitamente
    // pelo shape de `body` acima).
    const linha = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoUsuarioId)
      .query<{ senha_hash: string }>("SELECT senha_hash FROM Usuario WHERE id = @id");
    expect(await verifyPassword(SENHA_INICIAL_PADRAO, linha.recordset[0].senha_hash)).toBe(true);

    // Login imediato com a senha inicial funciona (sem precisar ativar por e-mail).
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL_NOVO_USUARIO, senha: SENHA_INICIAL_PADRAO },
    });
    expect(login.statusCode).toBe(200);
  });

  it("Admin não consegue criar segundo usuário com o mesmo e-mail (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: {
        nome: "Duplicata",
        email: EMAIL_NOVO_USUARIO,
        telefone: "31999990000",
        perfil: "colaborador",
        setorId: setorTiId,
      },
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

  it("Admin reenvia código (usuário já nasce verificado -> tipo reset_senha)", async () => {
    // Diferente do autocadastro: usuário criado pelo Admin já nasce com email_verificado=1
    // (senha inicial substitui a ativação por OTP), então "reenviar código" aqui é sempre
    // um reset de senha administrativo, nunca ativação.
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/usuarios/${novoUsuarioId}/reenviar-codigo`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tipo).toBe("reset_senha");
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
