import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S11 — RF-RES-15: thread cronológica de comentários por reserva, com notificação
// in-app ao(s) outro(s) participante(s) da conversa.

const EMAIL_SOLICITANTE = "teste.s11.solicitante@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S11-COMENTARIO";
const DATA_RESERVA = "2026-11-22";

let app: FastifyInstance;
let setorTiId: string;
let solicitanteId: string;
let plataformaId: string;
let reservaId: string;
let cookieSolicitante: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function limparDados() {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM Comentario WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (
       SELECT id FROM Usuario WHERE email = '${EMAIL_SOLICITANTE}'
     ) OR usuario_id IN (SELECT id FROM Usuario WHERE perfil = 'admin')`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`
  );
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  // LogAuditoria também é gravado com usuario_id = quem executou a ação (não só
  // entidade_id, que aqui aponta para o Comentario) — precisa ser limpo antes do DELETE
  // de Usuario (mesmo padrão de S8).
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_SOLICITANTE}')`
  );
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_SOLICITANTE}'`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparDados();

  const pool = await getPool();
  const setorTi = await pool.request().query<{ id: string }>("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma Teste S11 — Comentários")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const solicitante = await pool
    .request()
    .input("nome", sql.NVarChar, "Solicitante Teste S11 Comentários")
    .input("email", sql.NVarChar, EMAIL_SOLICITANTE)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  solicitanteId = solicitante.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginSolicitante = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_SOLICITANTE, senha: SENHA },
  });
  cookieSolicitante = extrairCookieToken(loginSolicitante.cookies.map((c) => `${c.name}=${c.value}`));

  const criacao = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieSolicitante },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio: "08:00",
      horaFim: "09:00",
      motivo: "Teste S11 — comentários",
      prioridade: "normal",
    },
  });
  reservaId = criacao.json().id as string;
});

afterAll(async () => {
  await limparDados();
  await app.close();
  await closePool();
});

describe("POST /reservas/:id/comentarios — RF-RES-15", () => {
  it("Admin comenta e o solicitante (outro participante) recebe notificação in-app", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/comentarios`,
      headers: { cookie: cookieAdmin },
      payload: { mensagem: "Poderia confirmar o horário de chegada?" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().mensagem).toBe("Poderia confirmar o horário de chegada?");

    const notificacoes = await app.inject({
      method: "GET",
      url: "/api/v1/notificacoes",
      headers: { cookie: cookieSolicitante },
    });
    expect(
      notificacoes.json().some((n: { tipo: string; link: string }) => n.tipo === "comentario_novo" && n.link === `/reservas/${reservaId}`)
    ).toBe(true);
  });

  it("GET retorna a thread em ordem cronológica", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/comentarios`,
      headers: { cookie: cookieSolicitante },
      payload: { mensagem: "Chegamos às 8h." },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/comentarios`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const thread = response.json();
    expect(thread.length).toBe(2);
    expect(new Date(thread[0].criadoEm).getTime()).toBeLessThanOrEqual(new Date(thread[1].criadoEm).getTime());
  });

  it("rejeita comentário vazio -> 422", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/comentarios`,
      headers: { cookie: cookieSolicitante },
      payload: { mensagem: "   " },
    });
    expect(response.statusCode).toBe(422);
  });
});
