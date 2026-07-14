import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// Dashboard — reescrita completa (KPIs expandidos + agenda "Hoje"/"Próximas" +
// checklists pendentes), escopo global (Admin) ou por setor (Gestor/Colaborador),
// conforme SDD §10/§11.
//
// Usa DOIS setores dedicados e exclusivos deste arquivo (nunca "TI") porque os campos
// testados aqui são contagens/listas agregadas por setor — reaproveitar um setor
// compartilhado por muitos outros arquivos de teste (ex.: "TI") colide com dados de
// outras suítes rodando contra o mesmo banco de desenvolvimento (ver lição registrada
// no relatório da Sprint S12).

const NOME_SETOR_A = "Setor Teste Dashboard S15 A";
const NOME_SETOR_B = "Setor Teste Dashboard S15 B";
const EMAIL_GESTOR_A = "teste.s15.dashboard.gestor.a@metalsider.com.br";
const EMAIL_COLABORADOR_A = "teste.s15.dashboard.colaborador.a@metalsider.com.br";
const EMAIL_COLABORADOR_B = "teste.s15.dashboard.colaborador.b@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S15-DASH";

let app: FastifyInstance;
let setorAId: string;
let setorBId: string;
let gestorAId: string;
let colaboradorAId: string;
let colaboradorBId: string;
let plataformaId: string;
let cookieAdmin: string;
let cookieGestorA: string;
let cookieColaboradorA: string;
let cookieColaboradorB: string;

let reservaHojeSetorAId: string;
let reservaAgendadaSemChecklistSetorAId: string;
let reservaComChecklistSetorAId: string;
let reservaHojeSetorBId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

function amanha(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  // Limpeza defensiva de execuções anteriores que tenham falhado no meio do caminho.
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_GESTOR_A}', '${EMAIL_COLABORADOR_A}', '${EMAIL_COLABORADOR_B}'))`
  );
  await pool.request().query(
    `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_GESTOR_A}', '${EMAIL_COLABORADOR_A}', '${EMAIL_COLABORADOR_B}')`);
  await pool.request().query(`DELETE FROM Setor WHERE nome IN ('${NOME_SETOR_A}', '${NOME_SETOR_B}')`);

  const setorA = await pool
    .request()
    .input("nome", sql.NVarChar, NOME_SETOR_A)
    .query<{ id: string }>("INSERT INTO Setor (nome, cor_hex) OUTPUT INSERTED.id VALUES (@nome, '#123456')");
  setorAId = setorA.recordset[0].id;

  const setorB = await pool
    .request()
    .input("nome", sql.NVarChar, NOME_SETOR_B)
    .query<{ id: string }>("INSERT INTO Setor (nome, cor_hex) OUTPUT INSERTED.id VALUES (@nome, '#654321')");
  setorBId = setorB.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma Elevatória Teste S15")
    .input("categoria", sql.VarChar, "elevatoria")
    .input("risco", sql.VarChar, "alto")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco)
       OUTPUT INSERTED.id VALUES (@codigo, @nome, @categoria, @risco)`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const gestorA = await pool
    .request()
    .input("nome", sql.NVarChar, "Gestor Setor A Teste S15")
    .input("email", sql.NVarChar, EMAIL_GESTOR_A)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorAId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'gestor_setor', @setor_id, 1, 1)`
    );
  gestorAId = gestorA.recordset[0].id;

  const colaboradorA = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Setor A Teste S15")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_A)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorAId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorAId = colaboradorA.recordset[0].id;

  const colaboradorB = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Setor B Teste S15")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_B)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorBId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorBId = colaboradorB.recordset[0].id;

  async function login(email: string, senha: string): Promise<string> {
    const resposta = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, senha } });
    expect(resposta.statusCode).toBe(200);
    return extrairCookieToken(resposta.cookies.map((c) => `${c.name}=${c.value}`));
  }

  cookieAdmin = await login(process.env.SEED_ADMIN_EMAIL as string, process.env.SEED_ADMIN_PASSWORD as string);
  cookieGestorA = await login(EMAIL_GESTOR_A, SENHA);
  cookieColaboradorA = await login(EMAIL_COLABORADOR_A, SENHA);
  cookieColaboradorB = await login(EMAIL_COLABORADOR_B, SENHA);

  const dataSegura = amanha();

  // Reserva "hoje" do Setor A: criada com data futura válida (respeita antecedência
  // mínima/expediente — RN-RES-03/06) e depois movida via SQL direto para a data de
  // hoje, para não depender do horário em que a suíte é executada.
  const criacaoHojeA = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorA },
    payload: {
      plataformaId,
      data: dataSegura,
      horaInicio: "09:00",
      horaFim: "10:00",
      motivo: "Reserva de hoje — Setor A (S15 dashboard)",
      prioridade: "normal",
    },
  });
  expect(criacaoHojeA.statusCode).toBe(201);
  reservaHojeSetorAId = criacaoHojeA.json().id;
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, reservaHojeSetorAId)
    .query("UPDATE Reserva SET data = CAST(GETDATE() AS DATE) WHERE id = @id");

  // Reserva "hoje" do Setor B (para os testes de exclusão entre setores).
  const criacaoHojeB = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorB },
    payload: {
      plataformaId,
      data: dataSegura,
      horaInicio: "10:30",
      horaFim: "11:30",
      motivo: "Reserva de hoje — Setor B (S15 dashboard)",
      prioridade: "normal",
    },
  });
  expect(criacaoHojeB.statusCode).toBe(201);
  reservaHojeSetorBId = criacaoHojeB.json().id;
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, reservaHojeSetorBId)
    .query("UPDATE Reserva SET data = CAST(GETDATE() AS DATE) WHERE id = @id");

  // Reserva agendada (aprovada pelo Admin em etapa única — RN-RES-08) sem checklist
  // preenchido: é o caso que DEVE aparecer em /dashboard/checklists-pendentes.
  const criacaoAgendadaSemChecklist = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorA },
    payload: {
      plataformaId,
      data: dataSegura,
      horaInicio: "13:00",
      horaFim: "14:00",
      motivo: "Reserva agendada sem checklist — Setor A (S15 dashboard)",
      prioridade: "normal",
    },
  });
  expect(criacaoAgendadaSemChecklist.statusCode).toBe(201);
  reservaAgendadaSemChecklistSetorAId = criacaoAgendadaSemChecklist.json().id;
  const aprovacao1 = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaAgendadaSemChecklistSetorAId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacao1.statusCode).toBe(200);
  expect(aprovacao1.json().status).toBe("agendada");

  // Reserva agendada COM checklist já preenchido (inserido direto via SQL, mesma
  // técnica já usada por outras suítes para isolar o teste do fluxo completo de
  // checklist.ts) — NÃO deve aparecer em /dashboard/checklists-pendentes.
  const criacaoComChecklist = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorA },
    payload: {
      plataformaId,
      data: dataSegura,
      horaInicio: "15:00",
      horaFim: "16:00",
      motivo: "Reserva agendada com checklist — Setor A (S15 dashboard)",
      prioridade: "normal",
    },
  });
  expect(criacaoComChecklist.statusCode).toBe(201);
  reservaComChecklistSetorAId = criacaoComChecklist.json().id;
  const aprovacao2 = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaComChecklistSetorAId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacao2.statusCode).toBe(200);
  await pool
    .request()
    .input("reserva_id", sql.UniqueIdentifier, reservaComChecklistSetorAId)
    .input("preenchido_por_id", sql.UniqueIdentifier, colaboradorAId)
    .query(
      `INSERT INTO ChecklistPreenchido (reserva_id, preenchido_por_id, todos_conformes)
       VALUES (@reserva_id, @preenchido_por_id, 1)`
    );
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_GESTOR_A}', '${EMAIL_COLABORADOR_A}', '${EMAIL_COLABORADOR_B}'))`
  );
  await pool.request().query(`DELETE FROM ChecklistPreenchido WHERE reserva_id = '${reservaComChecklistSetorAId}'`);
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_GESTOR_A}', '${EMAIL_COLABORADOR_A}', '${EMAIL_COLABORADOR_B}')`);
  await pool.request().query(`DELETE FROM Setor WHERE nome IN ('${NOME_SETOR_A}', '${NOME_SETOR_B}')`);
  await app.close();
  await closePool();
});

describe("Dashboard (S15 — reescrita: kpis expandidos, agenda, checklists pendentes)", () => {
  it("GET /dashboard/kpis (Admin) retorna todos os campos esperados, escopo global", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/kpis", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    for (const campo of [
      "totalPlataformas",
      "disponiveis",
      "emUso",
      "manutencao",
      "reservasHoje",
      "reservasProximos7Dias",
      "pendenciasAprovacao",
      "checklistsPendentes",
    ]) {
      expect(body).toHaveProperty(campo);
      expect(typeof body[campo]).toBe("number");
    }
    // Escopo global do Admin enxerga as reservas de hoje de AMBOS os setores de teste.
    expect(body.reservasHoje).toBeGreaterThanOrEqual(2);
    expect(body.checklistsPendentes).toBeGreaterThanOrEqual(1);
  });

  it("GET /dashboard/kpis (Gestor de Setor) conta reservasHoje só do próprio setor", async () => {
    const respostaGestorA = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpis",
      headers: { cookie: cookieGestorA },
    });
    expect(respostaGestorA.statusCode).toBe(200);
    // Setor A tem exatamente 1 reserva de "hoje" fabricada neste arquivo; como o setor é
    // exclusivo deste teste, nenhuma outra suíte pode ter inserido reservas nele.
    expect(respostaGestorA.json().reservasHoje).toBe(1);
    expect(respostaGestorA.json().checklistsPendentes).toBe(1);
  });

  it("GET /dashboard/agenda (Admin) inclui as reservas de hoje dos dois setores", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/agenda", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
    const ids = response.json().hoje.map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaHojeSetorAId);
    expect(ids).toContain(reservaHojeSetorBId);
  });

  it("GET /dashboard/agenda (Colaborador Setor A) só vê a reserva de hoje do próprio setor", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/agenda",
      headers: { cookie: cookieColaboradorA },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().hoje.map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaHojeSetorAId);
    expect(ids).not.toContain(reservaHojeSetorBId);
  });

  it("GET /dashboard/agenda (Colaborador Setor B) não vê reservas do Setor A", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/agenda",
      headers: { cookie: cookieColaboradorB },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().hoje.map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaHojeSetorBId);
    expect(ids).not.toContain(reservaHojeSetorAId);
  });

  it("GET /dashboard/checklists-pendentes inclui a reserva agendada sem checklist e exclui a que já tem checklist", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/checklists-pendentes",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaAgendadaSemChecklistSetorAId);
    expect(ids).not.toContain(reservaComChecklistSetorAId);
  });

  it("GET /dashboard/checklists-pendentes (Gestor de Setor) respeita o escopo do setor", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/checklists-pendentes",
      headers: { cookie: cookieGestorA },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((r: { id: string }) => r.id);
    expect(ids).toContain(reservaAgendadaSemChecklistSetorAId);

    const respostaColaboradorB = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/checklists-pendentes",
      headers: { cookie: cookieColaboradorB },
    });
    expect(respostaColaboradorB.json()).toEqual([]);
  });
});
