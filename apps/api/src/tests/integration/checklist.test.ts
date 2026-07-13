import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S8 — RF-CHK-*/RN-CHK-*/RN-RES-12: checklist de segurança obrigatório para plataformas
// de categoria elevatória/andaime, bloqueando a transição para "em_uso" sem checklist
// aprovado (RF-RES-10).

const EMAIL_COLABORADOR = "teste.s8.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA_ELEVATORIA = "PLT-S8-ELEV";
const CODIGO_PLATAFORMA_SALA = "PLT-S8-SALA";
const DATA_RESERVA = "2026-11-10";

let app: FastifyInstance;
let setorTiId: string;
let colaboradorId: string;
let plataformaElevatoriaId: string;
let plataformaSalaId: string;
let cookieColaborador: string;
let cookieAdmin: string;
let itensTemplateElevatoria: { id: string; obrigatorio: boolean }[];

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReserva(
  cookie: string,
  plataformaId: string,
  horaInicio: string,
  horaFim: string
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
      motivo: "Teste S8 — checklist de segurança",
      prioridade: "normal",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function criarEAprovarReserva(
  plataformaId: string,
  horaInicio: string,
  horaFim: string
): Promise<string> {
  const reservaId = await criarReserva(cookieColaborador, plataformaId, horaInicio, horaFim);
  const aprovacao = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacao.statusCode).toBe(200);
  expect(aprovacao.json().status).toBe("agendada");
  return reservaId;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  await pool.request().query(
    `DELETE FROM ChecklistResposta WHERE checklist_preenchido_id IN (
       SELECT id FROM ChecklistPreenchido WHERE reserva_id IN (
         SELECT id FROM Reserva WHERE plataforma_id IN (
           SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
         )
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (
       SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  const plataformaElevatoria = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_ELEVATORIA)
    .input("nome", sql.NVarChar, "Plataforma Elevatória de Teste S8")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'elevatoria', 'alto')`
    );
  plataformaElevatoriaId = plataformaElevatoria.recordset[0].id;

  const plataformaSala = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_SALA)
    .input("nome", sql.NVarChar, "Sala de Teste S8 (sem checklist)")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaSalaId = plataformaSala.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S8")
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

  const templates = await app.inject({
    method: "GET",
    url: "/api/v1/checklist-templates?categoria=elevatoria",
    headers: { cookie: cookieAdmin },
  });
  expect(templates.statusCode).toBe(200);
  itensTemplateElevatoria = templates.json();
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM ChecklistResposta WHERE checklist_preenchido_id IN (
       SELECT id FROM ChecklistPreenchido WHERE reserva_id IN (
         SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
     )`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')`);
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')`);
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorId}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorId}'`);
  await app.close();
  await closePool();
});

describe("GET /checklist-templates — RF-CHK-01", () => {
  it("categoria elevatória tem 6 itens, todos obrigatórios (SDD §17.9)", () => {
    expect(itensTemplateElevatoria.length).toBe(6);
    expect(itensTemplateElevatoria.every((i) => i.obrigatorio)).toBe(true);
  });
});

describe("GET /reservas/:id/checklist — plataforma sem exigência de checklist", () => {
  it("plataforma categoria 'sala' -> requerChecklist=false, sem itens", async () => {
    const reservaId = await criarEAprovarReserva(plataformaSalaId, "08:00", "09:00");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requerChecklist).toBe(false);
    expect(body.itens).toEqual([]);
  });
});

describe("PUT /reservas/:id/checklist — RN-CHK-01 (validação)", () => {
  it("item obrigatório sem resposta -> 422", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "09:00", "10:00");
    const respostasIncompletas = itensTemplateElevatoria
      .slice(0, 5)
      .map((item) => ({ itemId: item.id, conforme: true }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasIncompletas },
    });
    expect(response.statusCode).toBe(422);
  });

  it("item não conforme sem observação -> 422", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "10:00", "11:00");
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      conforme: index !== 0,
      observacao: index === 0 ? "" : undefined,
    }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(response.statusCode).toBe(422);
  });

  it("todos os itens conformes -> 200, todosConformes=true", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "11:00", "12:00");
    const respostas = itensTemplateElevatoria.map((item) => ({ itemId: item.id, conforme: true }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().todosConformes).toBe(true);

    const consulta = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
    });
    const body = consulta.json();
    expect(body.requerChecklist).toBe(true);
    expect(body.todosConformes).toBe(true);
    expect(body.itens.every((i: { conforme: boolean }) => i.conforme === true)).toBe(true);
  });

  it("um item não conforme com observação -> 200, todosConformes=false (cenário misto)", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "12:00", "13:00");
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      conforme: index !== 0,
      observacao: index === 0 ? "Guarda-corpo com folga — ajuste necessário." : undefined,
    }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().todosConformes).toBe(false);
  });
});

describe("PATCH /reservas/:id/status (iniciar_uso) — RF-RES-10/RN-RES-12", () => {
  it("plataforma elevatória sem checklist preenchido -> 409, erro explícito", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "13:00", "14:00");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toMatch(/checklist de segurança/i);
  });

  it("plataforma elevatória com checklist reprovado (item não conforme) -> 409", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "14:00", "15:00");
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      conforme: index !== 0,
      observacao: index === 0 ? "Sistema de freio não trava — reprovado." : undefined,
    }));
    const preenchimento = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(preenchimento.json().todosConformes).toBe(false);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toMatch(/não conforme|RN-CHK-02|bloqueado/i);
  });

  it("plataforma elevatória com checklist aprovado (todos conformes) -> 200, em_uso", async () => {
    const reservaId = await criarEAprovarReserva(plataformaElevatoriaId, "15:00", "16:00");
    const respostas = itensTemplateElevatoria.map((item) => ({ itemId: item.id, conforme: true }));
    const preenchimento = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(preenchimento.json().todosConformes).toBe(true);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("em_uso");
  });

  it("plataforma 'sala' (sem exigência) inicia uso normalmente sem checklist", async () => {
    const reservaId = await criarEAprovarReserva(plataformaSalaId, "16:00", "17:00");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("em_uso");
  });
});
