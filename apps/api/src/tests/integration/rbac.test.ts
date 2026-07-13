import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// Sprint S6 — matriz RBAC (rota x perfil), cobrindo 100% das rotas criadas em S1-S5.
// Perfis testados: Admin e Colaborador — "gestor_setor" só existe a partir de S7 (SDD §17.4,
// MASTER.md Fase 2), portanto ainda não faz parte do enum Usuario.perfil nem desta matriz.

const EMAIL_COLABORADOR_TI = "teste.rbac.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.rbac.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S6-RBAC";
const DATA_RESERVA = "2026-09-15";

let app: FastifyInstance;
let setorTiId: string;
let plataformaId: string;
let cookieAdmin: string;
let cookieColaboradorTi: string;
let cookieColaboradorManutencao: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReservaPendente(cookie: string, horaInicio: string, horaFim: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      motivo: "Reserva de evidência da suite RBAC (S6)",
      prioridade: "normal",
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
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo LIKE '${CODIGO_PLATAFORMA}%'`);
  await pool
    .request()
    .query(
      `DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}'))`
    );
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}'))`
    );
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}')`);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  const setorManutencaoId = setorManutencao.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Evidência RBAC S6")
    .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste RBAC S6")
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
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste RBAC S6")
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
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE entidade_id = '${plataformaId}'`);
  await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`);
  await pool
    .request()
    .query(
      `DELETE FROM CodigoVerificacao WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`
    );
  await pool
    .request()
    .query(`DELETE FROM Notificacao WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`);
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`);
  await app.close();
  await closePool();
});

describe("RBAC (S6) — rotas públicas, sem barreira de autenticação", () => {
  it("GET /api/v1/health é acessível sem cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
  });

  it("POST /api/v1/auth/login é acessível sem cookie (rejeita por credencial, não por RBAC)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "inexistente@metalsider.com.br", senha: "qualquercoisa1" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("POST /api/v1/auth/logout é acessível sem cookie", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(response.statusCode).toBe(200);
  });

  it("POST /api/v1/auth/ativar-conta é acessível sem cookie (rejeita por código, não por RBAC)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_COLABORADOR_TI, codigo: "000000", senha: "SenhaForte123" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("POST /api/v1/auth/recuperar-senha é acessível sem cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recuperar-senha",
      payload: { email: EMAIL_COLABORADOR_TI },
    });
    expect(response.statusCode).toBe(200);
  });

  it("POST /api/v1/auth/recuperar-senha/confirmar é acessível sem cookie (rejeita por código, não por RBAC)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recuperar-senha/confirmar",
      payload: { email: EMAIL_COLABORADOR_TI, codigo: "000000", novaSenha: "SenhaForte123" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("RBAC (S6) — GET /api/v1/conta e PATCH /api/v1/conta/senha (Todos autenticados)", () => {
  it("Admin acessa GET /conta (200)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/conta", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa GET /conta (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conta",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, GET /conta retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/conta" });
    expect(response.statusCode).toBe(401);
  });

  it("Colaborador troca a própria senha via PATCH /conta/senha (200 — rota acessível a Todos)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie: cookieColaboradorTi },
      payload: { senhaAtual: SENHA, novaSenha: "NovaSenhaForte456" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, PATCH /conta/senha retorna 401", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      payload: { senhaAtual: SENHA, novaSenha: "Outra123456" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("RBAC (S6) — GET /api/v1/dashboard/kpis (Todos autenticados)", () => {
  it("Admin acessa (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpis",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpis",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/dashboard/kpis" });
    expect(response.statusCode).toBe(401);
  });
});

describe("RBAC (S6) — GET /api/v1/setores (Todos autenticados)", () => {
  it("Admin acessa (200)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/setores", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setores",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/setores" });
    expect(response.statusCode).toBe(401);
  });
});

describe("RBAC (S6) — GET /api/v1/plataformas (Todos autenticados)", () => {
  it("Admin acessa (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/plataformas" });
    expect(response.statusCode).toBe(401);
  });
});

describe("RBAC (S6) — POST/PUT/PATCH /api/v1/plataformas (Admin apenas)", () => {
  it("Colaborador recebe 403 ao tentar POST /plataformas", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieColaboradorTi },
      payload: { codigo: "PLT-S6-NEGADA", nome: "Não deveria ser criada" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Sem cookie, POST /plataformas retorna 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      payload: { codigo: "PLT-S6-NEGADA2", nome: "Não deveria ser criada" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("Admin cria plataforma via POST /plataformas (201 — permitido)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieAdmin },
      payload: { codigo: `${CODIGO_PLATAFORMA}-2`, nome: "Segunda plataforma de evidência RBAC" },
    });
    expect(response.statusCode).toBe(201);
    const criada = response.json();
    // limpeza imediata — esta plataforma existe só para provar o 201, não é usada no resto da suite
    const pool = await getPool();
    await pool.request().input("id", sql.UniqueIdentifier, criada.id).query("DELETE FROM Plataforma WHERE id = @id");
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, criada.id)
      .query("DELETE FROM LogAuditoria WHERE entidade_id = @id");
  });

  it("Colaborador recebe 403 ao tentar PUT /plataformas/:id", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/plataformas/${plataformaId}`,
      headers: { cookie: cookieColaboradorTi },
      payload: { codigo: CODIGO_PLATAFORMA, nome: "Tentativa negada de edição" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin edita plataforma via PUT /plataformas/:id (200 — permitido)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/plataformas/${plataformaId}`,
      headers: { cookie: cookieAdmin },
      payload: { codigo: CODIGO_PLATAFORMA, nome: "Plataforma de Evidência RBAC S6 (editada)" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador recebe 403 ao tentar PATCH /plataformas/:id/status", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/plataformas/${plataformaId}/status`,
      headers: { cookie: cookieColaboradorTi },
      payload: { status: "manutencao" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin altera status via PATCH /plataformas/:id/status (200 — permitido)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/plataformas/${plataformaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { status: "disponivel" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("RBAC (S6) — POST/GET /api/v1/reservas e /reservas/conflitos (Todos autenticados)", () => {
  it("Colaborador cria reserva via POST /reservas (201 — permitido)", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "08:00", "09:00");
    expect(id).toBeTruthy();
  });

  it("Sem cookie, POST /reservas retorna 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "09:00",
        motivo: "Sem sessão",
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("Admin sem setor não é bloqueado por RBAC ao tentar POST /reservas — falha por regra de negócio (422), não por 401/403", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "13:00",
        horaFim: "14:00",
        motivo: "Admin não tem setor vinculado",
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it("Admin acessa GET /reservas (200)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/reservas", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa GET /reservas (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, GET /reservas retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/reservas" });
    expect(response.statusCode).toBe(401);
  });

  it("Colaborador acessa GET /reservas/conflitos (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/conflitos?plataformaId=${plataformaId}&data=${DATA_RESERVA}&horaInicio=08:00&horaFim=09:00`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, GET /reservas/conflitos retorna 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/conflitos?plataformaId=${plataformaId}&data=${DATA_RESERVA}&horaInicio=08:00&horaFim=09:00`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("RBAC (S6) — POST /reservas/:id/aprovar e /rejeitar (Admin apenas — ADR-S4)", () => {
  it("Colaborador recebe 403 ao tentar aprovar reserva", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "09:00", "10:00");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/aprovar`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(403);

    const admResponse = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(admResponse.statusCode).toBe(200);
    expect(admResponse.json().status).toBe("agendada");
  });

  it("Sem cookie, POST /reservas/:id/aprovar retorna 401", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "10:00", "11:00");
    const response = await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/aprovar` });
    expect(response.statusCode).toBe(401);

    // limpeza: aprova via Admin para permitir cancelamento consistente no afterAll (estado não-final)
    await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/aprovar`, headers: { cookie: cookieAdmin } });
    await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/cancelar`, headers: { cookie: cookieAdmin } });
  });

  it("Colaborador recebe 403 ao tentar rejeitar reserva", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "11:00", "12:00");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/rejeitar`,
      headers: { cookie: cookieColaboradorTi },
      payload: { motivo: "Tentativa negada de rejeição" },
    });
    expect(response.statusCode).toBe(403);

    const admResponse = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: { motivo: "Rejeitada legitimamente pelo Admin" },
    });
    expect(admResponse.statusCode).toBe(200);
    expect(admResponse.json().status).toBe("rejeitada");
  });

  it("Sem cookie, POST /reservas/:id/rejeitar retorna 401", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "12:00", "13:00");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/rejeitar`,
      payload: { motivo: "Sem sessão" },
    });
    expect(response.statusCode).toBe(401);

    // limpeza
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: { motivo: "Rejeitada legitimamente pelo Admin (limpeza)" },
    });
  });
});

describe("RBAC (S6) — PATCH /reservas/:id/status (Admin apenas — ADR-S4)", () => {
  it("Colaborador recebe 403 ao tentar avançar status; Admin consegue (200 — permitido)", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "14:00", "15:00");
    const aprovar = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(aprovar.statusCode).toBe(200);

    const negado = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${id}/status`,
      headers: { cookie: cookieColaboradorTi },
      payload: { acao: "iniciar_uso" },
    });
    expect(negado.statusCode).toBe(403);

    const permitido = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${id}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(permitido.statusCode).toBe(200);
    expect(permitido.json().status).toBe("em_uso");

    // limpeza: conclui a reserva para não deixar em_uso pendurada
    await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${id}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "concluir" },
    });
  });

  it("Sem cookie, PATCH /reservas/:id/status retorna 401", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "15:00", "16:00");
    await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/aprovar`, headers: { cookie: cookieAdmin } });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${id}/status`,
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(401);

    // limpeza
    await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/cancelar`, headers: { cookie: cookieAdmin } });
  });
});

describe("RBAC (S6) — POST /reservas/:id/cancelar (Todos autenticados, com escopo por setor)", () => {
  it("Colaborador de outro setor recebe 403 (escopo); Colaborador do próprio setor consegue (200 — permitido)", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "16:00", "17:00");

    const negado = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/cancelar`,
      headers: { cookie: cookieColaboradorManutencao },
    });
    expect(negado.statusCode).toBe(403);

    const permitido = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/cancelar`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(permitido.statusCode).toBe(200);
    expect(permitido.json().status).toBe("cancelada");
  });

  it("Admin cancela reserva de qualquer setor (200 — permitido)", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "17:00", "18:00");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/cancelar`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("cancelada");
  });

  it("Sem cookie, POST /reservas/:id/cancelar retorna 401", async () => {
    const id = await criarReservaPendente(cookieColaboradorTi, "18:00", "19:00");
    const response = await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/cancelar` });
    expect(response.statusCode).toBe(401);

    // limpeza
    await app.inject({ method: "POST", url: `/api/v1/reservas/${id}/cancelar`, headers: { cookie: cookieAdmin } });
  });
});

describe("RBAC (S6) — GET /api/v1/historico e /historico/export (Todos autenticados, escopo por setor)", () => {
  it("Admin acessa GET /historico (200)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/historico", headers: { cookie: cookieAdmin } });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa GET /historico (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, GET /historico retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/historico" });
    expect(response.statusCode).toBe(401);
  });

  it("Admin acessa GET /historico/export (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico/export",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Colaborador acessa GET /historico/export (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/historico/export",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
  });

  it("Sem cookie, GET /historico/export retorna 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/historico/export" });
    expect(response.statusCode).toBe(401);
  });
});
