import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_COLABORADOR_TI = "teste.aprovacao.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.aprovacao.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S4-TESTE";
const DATA_RESERVA = "2026-09-10";

let app: FastifyInstance;
let setorTiId: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;
let plataformaId: string;
let cookieColaboradorTi: string;
let cookieColaboradorManutencao: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReserva(cookie: string, horaInicio: string, horaFim: string, motivo: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie },
    payload: { plataformaId, data: DATA_RESERVA, horaInicio, horaFim, motivo, prioridade: "normal" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

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
  const setorManutencaoId = setorManutencao.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S4")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste S4")
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
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste S4")
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

describe("Reservas (S4) — fluxo pendente → agendada → em_uso → concluida", () => {
  let reservaId: string;

  it("Colaborador cria a reserva (pendente)", async () => {
    reservaId = await criarReserva(cookieColaboradorTi, "08:00", "09:00", "Fluxo completo de aprovação");
  });

  it("Colaborador não pode aprovar (403)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin aprova a reserva (pendente → agendada)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("agendada");
    expect(body.aprovadoPorNome).toBeTruthy();
  });

  it("Admin não pode aprovar de novo uma reserva já agendada (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(409);
  });

  it("Admin inicia o uso (agendada → em_uso)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("em_uso");
    expect(body.horaInicioReal).toBeTruthy();
  });

  it("Admin conclui o uso (em_uso → concluida)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "concluir" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("concluida");
    expect(body.horaFimReal).toBeTruthy();
  });

  it("Reserva concluída é somente leitura: iniciar_uso retorna 409", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("Reserva concluída é somente leitura: cancelar retorna 409", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/cancelar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("Reservas (S4) — fluxo pendente → rejeitada", () => {
  let reservaId: string;

  it("Colaborador cria a reserva (pendente)", async () => {
    reservaId = await criarReserva(cookieColaboradorTi, "10:00", "11:00", "Fluxo de rejeição");
  });

  it("Rejeitar sem motivo retorna 422", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  it("Admin rejeita com motivo (pendente → rejeitada)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: { motivo: "Plataforma reservada para manutenção preventiva nesse horário." },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("rejeitada");
    expect(body.motivoRejeicao).toContain("manutenção preventiva");
  });

  it("Reserva rejeitada → agendada (via aprovar) retorna 409", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("Reservas (S4) — cancelamento por escopo de setor", () => {
  it("Colaborador cancela reserva pendente do próprio setor (200)", async () => {
    const reservaId = await criarReserva(cookieColaboradorTi, "12:00", "13:00", "Cancelamento pelo próprio setor");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/cancelar`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelada");
  });

  it("Colaborador de outro setor não pode cancelar reserva alheia (403)", async () => {
    const reservaId = await criarReserva(cookieColaboradorTi, "13:00", "14:00", "Reserva de outro setor");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/cancelar`,
      headers: { cookie: cookieColaboradorManutencao },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin cancela reserva de qualquer setor (200)", async () => {
    const reservaId = await criarReserva(cookieColaboradorTi, "14:00", "15:00", "Cancelamento pelo Admin");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/cancelar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelada");
  });
});
