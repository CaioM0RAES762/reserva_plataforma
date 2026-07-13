import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S10 (RF-NOT-01/02): notificação in-app persistida na criação de reserva (ao aprovador
// elegível) e listagem/marcação de lida pelo destinatário.

const EMAIL_COLABORADOR = "teste.s10.notif.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S10-NOTIF";

let app: FastifyInstance;
let setorTiId: string;
let plataformaId: string;
let colaboradorId: string;
let cookieColaborador: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function limparDados(pool: Awaited<ReturnType<typeof getPool>>) {
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_COLABORADOR}')
       OR usuario_id IN (SELECT id FROM Usuario WHERE email = '${process.env.SEED_ADMIN_EMAIL}')`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();
  await limparDados(pool);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S10 — Notificações")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S10 Notificações")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

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
    payload: { email: EMAIL_COLABORADOR, senha: SENHA },
  });
  expect(loginColaborador.statusCode).toBe(200);
  cookieColaborador = extrairCookieToken(loginColaborador.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  const pool = await getPool();
  await limparDados(pool);
  await app.close();
  await closePool();
});

describe("Notificações in-app (S10 — RF-NOT-01/02)", () => {
  let notificacaoId: string;

  it("criar uma reserva persiste Notificacao (reserva_pendente) para o Admin, além do e-mail", async () => {
    const criacao = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: "2026-10-06",
        horaInicio: "09:00",
        horaFim: "10:00",
        motivo: "Reserva de teste de notificação in-app — S10",
      },
    });
    expect(criacao.statusCode).toBe(201);

    const lista = await app.inject({
      method: "GET",
      url: "/api/v1/notificacoes",
      headers: { cookie: cookieAdmin },
    });
    expect(lista.statusCode).toBe(200);
    const notificacoes = lista.json();
    const encontrada = notificacoes.find((n: { tipo: string; link: string | null }) => n.tipo === "reserva_pendente" && n.link === "/reservas/aprovacoes");
    expect(encontrada).toBeTruthy();
    expect(encontrada.lida).toBe(false);
    notificacaoId = encontrada.id;
  });

  it("Colaborador não vê a notificação do Admin em sua própria lista (escopo por usuario_id)", async () => {
    const lista = await app.inject({
      method: "GET",
      url: "/api/v1/notificacoes",
      headers: { cookie: cookieColaborador },
    });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().some((n: { id: string }) => n.id === notificacaoId)).toBe(false);
  });

  it("Colaborador não pode marcar como lida uma notificação de outro usuário (404 — não é dele)", async () => {
    const resposta = await app.inject({
      method: "PATCH",
      url: `/api/v1/notificacoes/${notificacaoId}/lida`,
      headers: { cookie: cookieColaborador },
    });
    expect(resposta.statusCode).toBe(404);
  });

  it("Admin marca a própria notificação como lida (204) e ela aparece lida na listagem seguinte", async () => {
    const marcar = await app.inject({
      method: "PATCH",
      url: `/api/v1/notificacoes/${notificacaoId}/lida`,
      headers: { cookie: cookieAdmin },
    });
    expect(marcar.statusCode).toBe(204);

    const lista = await app.inject({
      method: "GET",
      url: "/api/v1/notificacoes",
      headers: { cookie: cookieAdmin },
    });
    const encontrada = lista.json().find((n: { id: string }) => n.id === notificacaoId);
    expect(encontrada.lida).toBe(true);
  });

  it("PATCH /notificacoes/lidas marca todas as pendentes do usuário logado de uma vez", async () => {
    // gera mais uma notificação pendente para o Admin
    const criacao = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: "2026-10-13",
        horaInicio: "09:00",
        horaFim: "10:00",
        motivo: "Segunda reserva de teste de notificação in-app — S10",
      },
    });
    expect(criacao.statusCode).toBe(201);

    const marcarTodas = await app.inject({
      method: "PATCH",
      url: "/api/v1/notificacoes/lidas",
      headers: { cookie: cookieAdmin },
    });
    expect(marcarTodas.statusCode).toBe(204);

    const lista = await app.inject({
      method: "GET",
      url: "/api/v1/notificacoes",
      headers: { cookie: cookieAdmin },
    });
    expect(lista.json().every((n: { lida: boolean }) => n.lida === true)).toBe(true);
  });
});
