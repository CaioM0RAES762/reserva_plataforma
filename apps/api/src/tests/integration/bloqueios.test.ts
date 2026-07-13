import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S9 — RF-BLK-*/RN-RES-11/RN-BLK-01: bloqueios de agenda (manutenção/feriado) e
// reservas recorrentes semanais (RF-RES-03).

const EMAIL_COLABORADOR = "teste.s9.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S9-TESTE";
const CODIGO_PLATAFORMA_RECORRENCIA = "PLT-S9-RECORRENCIA";

let app: FastifyInstance;
let setorTiId: string;
let colaboradorId: string;
let plataformaId: string;
let plataformaRecorrenciaId: string;
let cookieColaborador: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function limparDados(pool: Awaited<ReturnType<typeof getPool>>) {
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_RECORRENCIA}'))
     ) OR entidade_id IN (SELECT id FROM BloqueioAgenda WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_RECORRENCIA}')))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_RECORRENCIA}'))`);
  // Reserva.recorrencia_id já foi limpo acima — falta remover a própria ReservaRecorrencia
  // (referencia Usuario.criado_por_id) antes de poder apagar o Colaborador de teste.
  await pool
    .request()
    .query(`DELETE FROM ReservaRecorrencia WHERE criado_por_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_COLABORADOR}')`);
  await pool
    .request()
    .query(`DELETE FROM BloqueioAgenda WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_RECORRENCIA}'))`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_RECORRENCIA}')`);
  // S10: Notificacao.usuario_id referencia Usuario — precisa ser limpa antes (FK).
  await pool
    .request()
    .query(`DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_COLABORADOR}')`);
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
    .input("nome", sql.NVarChar, "Plataforma de Teste S9")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaId = plataforma.recordset[0].id;

  const plataformaRecorrencia = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_RECORRENCIA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S9 — Recorrência")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaRecorrenciaId = plataformaRecorrencia.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S9")
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

describe("Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada", () => {
  const DATA_BLOQUEIO = "2026-09-01";
  let bloqueioId: string;

  it("Admin cria um bloqueio de agenda para a plataforma de teste (dia inteiro)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bloqueios",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        dataInicio: `${DATA_BLOQUEIO}T00:00`,
        dataFim: `${DATA_BLOQUEIO}T23:59`,
        motivo: "Parada programada — teste S9",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.plataformaId).toBe(plataformaId);
    bloqueioId = body.id;
  });

  it("POST /reservas dentro do período bloqueado é rejeitada (409) com o motivo explicado", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_BLOQUEIO,
        horaInicio: "09:00",
        horaFim: "10:00",
        motivo: "Reserva que não deveria ser criada — dentro de bloqueio",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("bloqueada pela agenda");
    expect(response.json().erro).toContain("Parada programada — teste S9");
  });

  it("GET /reservas/conflitos também reporta o bloqueio para o mesmo horário", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/conflitos?plataformaId=${plataformaId}&data=${DATA_BLOQUEIO}&horaInicio=09:00&horaFim=10:00`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.conflito).toBe(true);
    expect(body.motivo).toContain("bloqueada pela agenda");
  });

  it("POST /reservas em outra plataforma (não coberta pelo bloqueio específico) é aceita", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId: plataformaRecorrenciaId,
        data: DATA_BLOQUEIO,
        horaInicio: "09:00",
        horaFim: "10:00",
        motivo: "Reserva em plataforma não bloqueada",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("Colaborador não pode criar bloqueio (403)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bloqueios",
      headers: { cookie: cookieColaborador },
      payload: { dataInicio: "2026-09-02T00:00", dataFim: "2026-09-02T23:59", motivo: "Tentativa não autorizada" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Colaborador consegue LISTAR bloqueios (leitura liberada a todos, RF-CAL-01)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bloqueios",
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().some((b: { id: string }) => b.id === bloqueioId)).toBe(true);
  });

  it("Colaborador não pode remover bloqueio (403)", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/bloqueios/${bloqueioId}`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin remove o bloqueio futuro com sucesso (204)", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/bloqueios/${bloqueioId}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(204);
  });

  it("Após a remoção, a mesma reserva antes bloqueada agora é aceita", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_BLOQUEIO,
        horaInicio: "09:00",
        horaFim: "10:00",
        motivo: "Reserva aceita após remoção do bloqueio",
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe("Bloqueios de Agenda (S9) — RN-BLK-01: confirmação dupla sobre reserva já agendada", () => {
  const DATA_RESERVA_EXISTENTE = "2026-09-15";
  let reservaAgendadaId: string;

  it("cria e aprova uma reserva (agendada) na plataforma de teste", async () => {
    const criacao = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA_EXISTENTE,
        horaInicio: "13:00",
        horaFim: "15:00",
        motivo: "Reserva que será atingida por um bloqueio posterior",
      },
    });
    expect(criacao.statusCode).toBe(201);
    reservaAgendadaId = criacao.json().id;

    const aprovacao = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaAgendadaId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(aprovacao.statusCode).toBe(200);
    expect(aprovacao.json().status).toBe("agendada");
  });

  it("POST /bloqueios sobre o mesmo período SEM confirmar retorna a lista de conflitantes (200, não cria)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bloqueios",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        dataInicio: `${DATA_RESERVA_EXISTENTE}T00:00`,
        dataFim: `${DATA_RESERVA_EXISTENTE}T23:59`,
        motivo: "Manutenção preventiva — colide com reserva agendada",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requerConfirmacao).toBe(true);
    expect(body.reservasConflitantes.some((r: { id: string }) => r.id === reservaAgendadaId)).toBe(true);
  });

  it("BloqueioAgenda NÃO foi criado após a tentativa sem confirmação", async () => {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .query("SELECT COUNT(*) AS total FROM BloqueioAgenda WHERE plataforma_id = @plataforma_id");
    expect(resultado.recordset[0].total).toBe(0);
  });

  it("POST /bloqueios com confirmar=true efetiva o bloqueio mesmo com a reserva agendada (201)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bloqueios",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        dataInicio: `${DATA_RESERVA_EXISTENTE}T00:00`,
        dataFim: `${DATA_RESERVA_EXISTENTE}T23:59`,
        motivo: "Manutenção preventiva — colide com reserva agendada",
        confirmar: true,
      },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe("Reservas recorrentes (S9 — RF-RES-03)", () => {
  const DATA_BASE = "2026-09-07"; // segunda-feira

  it("POST /reservas com recorrencia cria 12 ocorrências semanais vinculadas pelo mesmo recorrenciaId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId: plataformaRecorrenciaId,
        data: DATA_BASE,
        horaInicio: "08:00",
        horaFim: "09:00",
        motivo: "Reunião semanal recorrente — teste S9",
        recorrencia: { quantidadeOcorrencias: 12 },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.recorrenciaId).toBeTruthy();
    expect(body.reservas).toHaveLength(12);
    expect(body.reservas[0].data).toBe("2026-09-07");
    expect(body.reservas[11].data).toBe("2026-11-23");
    expect(body.reservas.every((r: { recorrenciaId: string }) => r.recorrenciaId === body.recorrenciaId)).toBe(true);
  });

  it("uma segunda tentativa de série sobre as MESMAS datas é rejeitada por inteiro (tudo ou nada) — nenhuma nova reserva criada", async () => {
    const pool = await getPool();
    const antes = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaRecorrenciaId)
      .query("SELECT COUNT(*) AS total FROM Reserva WHERE plataforma_id = @plataforma_id");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId: plataformaRecorrenciaId,
        data: DATA_BASE,
        horaInicio: "08:00",
        horaFim: "09:00",
        motivo: "Série conflitante — não deveria criar nenhuma ocorrência",
        recorrencia: { quantidadeOcorrencias: 12 },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("série semanal");

    const depois = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaRecorrenciaId)
      .query("SELECT COUNT(*) AS total FROM Reserva WHERE plataforma_id = @plataforma_id");
    expect(depois.recordset[0].total).toBe(antes.recordset[0].total);
  });

  it("Cancelar série cancela todas as ocorrências futuras pendente/agendada de uma vez", async () => {
    const pool = await getPool();
    const serie = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaRecorrenciaId)
      .query<{ recorrencia_id: string }>(
        "SELECT DISTINCT recorrencia_id FROM Reserva WHERE plataforma_id = @plataforma_id AND recorrencia_id IS NOT NULL"
      );
    const recorrenciaId = serie.recordset[0].recorrencia_id;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/recorrencia/${recorrenciaId}/cancelar`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ocorrenciasCanceladas).toBe(12);

    const restantes = await pool
      .request()
      .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
      .query<{ status: string }>("SELECT status FROM Reserva WHERE recorrencia_id = @recorrencia_id");
    expect(restantes.recordset.every((r) => r.status === "cancelada")).toBe(true);
  });
});
