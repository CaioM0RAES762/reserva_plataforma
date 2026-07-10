import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S7 — RN-RES-07/08: aprovação simples pelo Gestor de Setor vs. dupla aprovação
// (Gestor + Admin) para reservas urgentes ou em plataformas de risco alto.

const EMAIL_COLABORADOR = "teste.s7.colaborador@metalsider.com.br";
const EMAIL_GESTOR_TI = "teste.s7.gestor.ti@metalsider.com.br";
const EMAIL_GESTOR_MANUTENCAO = "teste.s7.gestor.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA_SIMPLES = "PLT-S7-SIMPLES";
const CODIGO_PLATAFORMA_RISCO_ALTO = "PLT-S7-ALTO";
const DATA_RESERVA = "2026-10-05";

let app: FastifyInstance;
let setorTiId: string;
let colaboradorId: string;
let gestorTiId: string;
let gestorManutencaoId: string;
let plataformaSimplesId: string;
let plataformaRiscoAltoId: string;
let cookieColaborador: string;
let cookieGestorTi: string;
let cookieGestorManutencao: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReserva(
  cookie: string,
  plataformaId: string,
  horaInicio: string,
  horaFim: string,
  prioridade: "normal" | "alta" | "urgente"
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      motivo: "Teste S7 — dupla aprovação",
      prioridade,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_SIMPLES}', '${CODIGO_PLATAFORMA_RISCO_ALTO}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (
       SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_SIMPLES}', '${CODIGO_PLATAFORMA_RISCO_ALTO}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_SIMPLES}', '${CODIGO_PLATAFORMA_RISCO_ALTO}')`);
  await pool
    .request()
    .query(
      `DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_GESTOR_TI}', '${EMAIL_GESTOR_MANUTENCAO}')`
    );

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  const setorManutencaoId = setorManutencao.recordset[0].id;

  const plataformaSimples = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_SIMPLES)
    .input("nome", sql.NVarChar, "Sala de Teste S7 (risco baixo)")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaSimplesId = plataformaSimples.recordset[0].id;

  const plataformaRiscoAlto = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_RISCO_ALTO)
    .input("nome", sql.NVarChar, "Plataforma Elevatória de Teste S7 (risco alto)")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'elevatoria', 'alto')`
    );
  plataformaRiscoAltoId = plataformaRiscoAlto.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S7")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const gestorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Gestor de Setor TI — Teste S7")
    .input("email", sql.NVarChar, EMAIL_GESTOR_TI)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'gestor_setor', @setor_id, 1, 1)`
    );
  gestorTiId = gestorTi.recordset[0].id;

  const gestorManutencao = await pool
    .request()
    .input("nome", sql.NVarChar, "Gestor de Setor Manutenção — Teste S7")
    .input("email", sql.NVarChar, EMAIL_GESTOR_MANUTENCAO)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorManutencaoId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'gestor_setor', @setor_id, 1, 1)`
    );
  gestorManutencaoId = gestorManutencao.recordset[0].id;

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

  const loginGestorTi = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_GESTOR_TI, senha: SENHA },
  });
  expect(loginGestorTi.statusCode).toBe(200);
  cookieGestorTi = extrairCookieToken(loginGestorTi.cookies.map((c) => `${c.name}=${c.value}`));

  const loginGestorManutencao = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_GESTOR_MANUTENCAO, senha: SENHA },
  });
  expect(loginGestorManutencao.statusCode).toBe(200);
  cookieGestorManutencao = extrairCookieToken(
    loginGestorManutencao.cookies.map((c) => `${c.name}=${c.value}`)
  );
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaSimplesId}', '${plataformaRiscoAltoId}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN ('${plataformaSimplesId}', '${plataformaRiscoAltoId}')`);
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE id IN ('${plataformaSimplesId}', '${plataformaRiscoAltoId}')`);
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN ('${colaboradorId}', '${gestorTiId}', '${gestorManutencaoId}')`
    );
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE id IN ('${colaboradorId}', '${gestorTiId}', '${gestorManutencaoId}')`);
  await app.close();
  await closePool();
});

describe("Aprovação simples pelo Gestor de Setor (RN-RES-07) — risco baixo/médio, prioridade normal/alta", () => {
  it("Gestor de Setor aprova sozinho reserva normal em plataforma de risco baixo -> agendada direto", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaSimplesId, "08:00", "09:00", "normal");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("agendada");
    expect(body.aprovadoPorNome).toContain("Gestor de Setor TI");
    expect(body.segundaAprovacaoPorNome).toBeNull();
  });

  it("Gestor de outro setor não pode aprovar reserva alheia (403 — fora de escopo)", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaSimplesId, "09:00", "10:00", "normal");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorManutencao },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Dupla aprovação obrigatória (RN-RES-08) — prioridade urgente, estado intermediário", () => {
  it("fluxo completo: Gestor aprova (permanece pendente) -> Admin dá a segunda aprovação (agendada)", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaSimplesId, "10:00", "11:00", "urgente");

    // 1) Gestor de Setor dá a primeira aprovação — RN-RES-08: a reserva DEVE permanecer
    // "pendente" (estado intermediário), com aprovado_por_id já preenchido.
    const respostaGestor = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });
    expect(respostaGestor.statusCode).toBe(200);
    const corpoGestor = respostaGestor.json();
    expect(corpoGestor.status).toBe("pendente");
    expect(corpoGestor.aprovadoPorNome).toContain("Gestor de Setor TI");
    expect(corpoGestor.segundaAprovacaoPorNome).toBeNull();

    // 2) Gestor não pode aprovar de novo a mesma reserva (já deu sua aprovação).
    const respostaGestorRepetida = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });
    expect(respostaGestorRepetida.statusCode).toBe(409);

    // 3) Admin dá a segunda aprovação — só agora a reserva muda para "agendada".
    const respostaAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(respostaAdmin.statusCode).toBe(200);
    const corpoAdmin = respostaAdmin.json();
    expect(corpoAdmin.status).toBe("agendada");
    expect(corpoAdmin.aprovadoPorNome).toContain("Gestor de Setor TI");
    expect(corpoAdmin.segundaAprovacaoPorNome).toBe("Administrador");
  });

  it("Admin aprova diretamente uma reserva de risco alto, sem esperar o Gestor -> agendada de uma vez", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaRiscoAltoId, "11:00", "12:00", "normal");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("agendada");
    expect(body.aprovadoPorNome).toBe("Administrador");
    expect(body.segundaAprovacaoPorNome).toBeNull();
  });

  it("Gestor de Setor aprova reserva em plataforma de risco alto: permanece pendente (dupla por risco, não por prioridade)", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaRiscoAltoId, "12:00", "13:00", "normal");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("pendente");
    expect(body.aprovadoPorNome).toContain("Gestor de Setor TI");
  });

  it("rejeição em qualquer etapa finaliza como rejeitada, mesmo após a primeira aprovação do Gestor", async () => {
    const reservaId = await criarReserva(cookieColaborador, plataformaSimplesId, "13:00", "14:00", "urgente");

    const respostaGestor = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });
    expect(respostaGestor.json().status).toBe("pendente");

    const respostaRejeicao = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: { motivo: "Reavaliação de prioridade pelo Admin." },
    });
    expect(respostaRejeicao.statusCode).toBe(200);
    expect(respostaRejeicao.json().status).toBe("rejeitada");
  });
});

describe("Fila de Aprovações (S7) — escopo por perfil", () => {
  it("Gestor de Setor só vê pendentes do próprio setor, sem exigir segunda aprovação restante", async () => {
    const reservaSimples = await criarReserva(cookieColaborador, plataformaSimplesId, "14:00", "15:00", "normal");
    const reservaUrgente = await criarReserva(cookieColaborador, plataformaSimplesId, "15:00", "16:00", "urgente");

    // Gestor já aprovou a urgente uma vez — não deve mais aparecer na fila dele.
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaUrgente}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas/fila-aprovacoes",
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaSimples);
    expect(ids).not.toContain(reservaUrgente);
  });

  it("Admin vê todas as pendentes, incluindo as que aguardam segunda aprovação", async () => {
    const reservaUrgente = await criarReserva(cookieColaborador, plataformaSimplesId, "16:00", "17:00", "urgente");
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaUrgente}/aprovar`,
      headers: { cookie: cookieGestorTi },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas/fila-aprovacoes",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const item = response.json().find((r: { id: string }) => r.id === reservaUrgente);
    expect(item).toBeDefined();
    expect(item.aguardaSegundaAprovacao).toBe(true);
  });

  it("Colaborador não acessa a Fila de Aprovações (403)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas/fila-aprovacoes",
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(403);
  });
});
