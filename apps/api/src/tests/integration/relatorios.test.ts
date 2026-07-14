import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";
import { limparCacheRelatorios } from "../../services/relatorioCache.service.js";

// S13 — RF-REL-01..06 (SDD §6.7): período de teste isolado (2027-03-01/02, fora de
// qualquer outro dado seedado/demo de sprints anteriores) para que os agregados globais
// (ranking-setores, segurança) fiquem determinísticos mesmo rodando contra o mesmo banco
// que as demais suítes de integração.

const EMAIL_GESTOR_TI = "teste.s13.gestor.ti@metalsider.com.br";
const EMAIL_COLABORADOR_TI = "teste.s13.colaborador.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.s13.colaborador.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S13-TESTE";
const DATE_FROM = "2027-03-01";
const DATE_TO = "2027-03-02";

let app: FastifyInstance;
let setorTiId: string;
let setorManutencaoId: string;
let gestorTiId: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;
let plataformaId: string;
let cookieAdmin: string;
let cookieGestorTi: string;
let cookieColaboradorTi: string;
let reservaAId: string; // TI, agendada, 2h
let reservaBId: string; // TI, rejeitada, 0.5h
let reservaCId: string; // Manutenção, agendada, 1h

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function limparDados() {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
    );
  await pool.request().query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_GESTOR_TI}', '${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}'))`
    );
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_GESTOR_TI}', '${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_GESTOR_TI}', '${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}')`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparCacheRelatorios();
  await limparDados();

  const pool = await getPool();

  const setorTi = await pool.request().query<{ id: string }>("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query<{ id: string }>("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  setorManutencaoId = setorManutencao.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma Relatório S13")
    .input("categoria", sql.VarChar, "sala")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria) OUTPUT INSERTED.id VALUES (@codigo, @nome, @categoria)`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const gestorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Gestor TI Teste S13")
    .input("email", sql.NVarChar, EMAIL_GESTOR_TI)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'gestor_setor', @setor_id, 1, 1)`
    );
  gestorTiId = gestorTi.recordset[0].id;

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste S13")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_TI)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorTiId = colaboradorTi.recordset[0].id;

  const colaboradorManutencao = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste S13")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_MANUTENCAO)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorManutencaoId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorManutencaoId = colaboradorManutencao.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginGestorTi = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_GESTOR_TI, senha: SENHA },
  });
  expect(loginGestorTi.statusCode).toBe(200);
  cookieGestorTi = extrairCookieToken(loginGestorTi.cookies.map((c) => `${c.name}=${c.value}`));

  const loginColaboradorTi = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_TI, senha: SENHA },
  });
  expect(loginColaboradorTi.statusCode).toBe(200);
  cookieColaboradorTi = extrairCookieToken(loginColaboradorTi.cookies.map((c) => `${c.name}=${c.value}`));

  const loginColaboradorManutencao = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_MANUTENCAO, senha: SENHA },
  });
  expect(loginColaboradorManutencao.statusCode).toBe(200);
  const cookieColaboradorManutencao = extrairCookieToken(
    loginColaboradorManutencao.cookies.map((c) => `${c.name}=${c.value}`)
  );

  // reservaA — setor TI, 2027-03-01 08:00–10:00 (2h) — aprovada pelo Admin → agendada.
  const criacaoA = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorTi },
    payload: {
      plataformaId,
      data: DATE_FROM,
      horaInicio: "08:00",
      horaFim: "10:00",
      motivo: "Reunião de planejamento S13",
      prioridade: "normal",
    },
  });
  expect(criacaoA.statusCode).toBe(201);
  reservaAId = criacaoA.json().id;
  const aprovacaoA = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaAId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacaoA.statusCode).toBe(200);

  // reservaB — setor TI, 2027-03-01 11:00–11:30 (0.5h) — rejeitada pelo Admin.
  const criacaoB = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorTi },
    payload: {
      plataformaId,
      data: DATE_FROM,
      horaInicio: "11:00",
      horaFim: "11:30",
      motivo: "Reunião de alinhamento rápido",
      prioridade: "normal",
    },
  });
  expect(criacaoB.statusCode).toBe(201);
  reservaBId = criacaoB.json().id;
  const rejeicaoB = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaBId}/rejeitar`,
    headers: { cookie: cookieAdmin },
    payload: { motivo: "Sala já ocupada por outro compromisso prioritário." },
  });
  expect(rejeicaoB.statusCode).toBe(200);

  // reservaC — setor Manutenção, 2027-03-02 14:00–15:00 (1h) — aprovada pelo Admin.
  const criacaoC = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaboradorManutencao },
    payload: {
      plataformaId,
      data: DATE_TO,
      horaInicio: "14:00",
      horaFim: "15:00",
      motivo: "Reunião de manutenção preventiva",
      prioridade: "normal",
    },
  });
  expect(criacaoC.statusCode).toBe(201);
  reservaCId = criacaoC.json().id;
  const aprovacaoC = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaCId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacaoC.statusCode).toBe(200);
});

afterAll(async () => {
  await limparDados();
  await limparCacheRelatorios();
  await app.close();
  await closePool();
});

describe("Relatórios (S13) — RF-REL-01: GET /relatorios/utilizacao", () => {
  it("Admin (global) soma horas reservadas de TODOS os setores para a plataforma", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const linha = body.plataformas.find((p: { plataformaId: string }) => p.plataformaId === plataformaId);
    expect(linha).toBeDefined();
    // 48h no período (2 dias), sem bloqueios de agenda.
    expect(linha.horasDisponiveis).toBe(48);
    // reservaA (2h, agendada) + reservaC (1h, agendada) — reservaB é rejeitada, não conta.
    expect(linha.horasReservadas).toBe(3);
    expect(linha.taxaUtilizacao).toBe(6.25); // 3/48*100
  });

  it("Gestor de Setor (TI) só soma as horas das reservas do PRÓPRIO setor, mesmo a plataforma sendo compartilhada", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(200);
    const linha = response.json().plataformas.find((p: { plataformaId: string }) => p.plataformaId === plataformaId);
    // Só reservaA (2h, TI) — reservaC é do setor Manutenção, fora do escopo do Gestor TI.
    expect(linha.horasReservadas).toBe(2);
  });

  it("Colaborador não acessa relatórios (403 — SDD §6.7, RF-REL fora do perfil Colaborador)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Relatórios (S13) — RF-REL-02: GET /relatorios/ranking-setores (Admin only)", () => {
  it("Admin vê o ranking global com volume e taxa de rejeição exatos", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/ranking-setores?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const setores = response.json().setores as Array<{
      setorId: string;
      setorNome: string;
      totalReservas: number;
      totalRejeitadas: number;
      taxaRejeicao: number;
    }>;
    const ti = setores.find((s) => s.setorId === setorTiId);
    const manutencao = setores.find((s) => s.setorId === setorManutencaoId);
    expect(ti).toMatchObject({ totalReservas: 2, totalRejeitadas: 1, taxaRejeicao: 50 });
    expect(manutencao).toMatchObject({ totalReservas: 1, totalRejeitadas: 0, taxaRejeicao: 0 });
  });

  it("Gestor de Setor recebe 403 (visão entre setores é exclusiva do Admin)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/ranking-setores?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("Relatórios (S13) — RF-REL-03/04: GET /relatorios/sla-aprovacao", () => {
  it("Admin (global) contabiliza as 3 reservas do período; Gestor TI só as 2 do próprio setor", async () => {
    const respostaAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/sla-aprovacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(respostaAdmin.statusCode).toBe(200);
    const corpoAdmin = respostaAdmin.json();
    expect(corpoAdmin.totalDecisoes).toBe(3);
    expect(corpoAdmin.tempoMedioAprovacaoHoras).toBeGreaterThanOrEqual(0);

    const porStatusAdmin = corpoAdmin.porStatus as Array<{ chave: string; quantidade: number }>;
    expect(porStatusAdmin.find((s) => s.chave === "agendada")?.quantidade).toBe(2);
    expect(porStatusAdmin.find((s) => s.chave === "rejeitada")?.quantidade).toBe(1);

    const respostaGestor = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/sla-aprovacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(respostaGestor.statusCode).toBe(200);
    expect(respostaGestor.json().totalDecisoes).toBe(2);
  });
});

describe("Relatórios (S13) — RF-REL-05: GET /relatorios/seguranca (Admin only)", () => {
  it("Admin acessa; Gestor de Setor recebe 403", async () => {
    const respostaAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/seguranca?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(respostaAdmin.statusCode).toBe(200);
    expect(respostaAdmin.json()).toHaveProperty("percentualChecklistNaoConforme");

    const respostaGestor = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/seguranca?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(respostaGestor.statusCode).toBe(403);
  });
});

describe("Relatórios (S13) — cache Redis (TTL 15 min)", () => {
  it("primeira chamada é MISS (calcula e grava no cache); segunda chamada idêntica dentro do TTL é HIT com o MESMO corpo, sem recalcular", async () => {
    await limparCacheRelatorios();

    const primeira = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(primeira.statusCode).toBe(200);
    expect(primeira.headers["x-cache"]).toBe("MISS");

    const segunda = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(segunda.statusCode).toBe(200);
    expect(segunda.headers["x-cache"]).toBe("HIT");
    expect(segunda.body).toBe(primeira.body);
  });

  it("escopos diferentes (Admin global vs. Gestor TI) usam chaves de cache DIFERENTES — não vazam dado de um escopo para o outro", async () => {
    await limparCacheRelatorios();

    const respostaAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    const respostaGestor = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/utilizacao?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    // Ambas MISS (chaves diferentes: escopo global vs. setor TI) — se compartilhassem
    // chave, a segunda seria HIT com o corpo (errado) do escopo global.
    expect(respostaAdmin.headers["x-cache"]).toBe("MISS");
    expect(respostaGestor.headers["x-cache"]).toBe("MISS");
    expect(respostaAdmin.body).not.toBe(respostaGestor.body);
  });
});

describe("Relatórios (S13) — RF-REL-06: GET /relatorios/export", () => {
  it("exporta Excel real (.xlsx) com Content-Type e corpo binário não vazio", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/export?relatorio=utilizacao&formato=excel&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
    expect(response.headers["content-disposition"]).toContain(".xlsx");
    expect(response.rawPayload.length).toBeGreaterThan(1000);
    // Assinatura de arquivo ZIP (xlsx é um pacote OOXML/ZIP) — prova que é um arquivo real.
    expect(response.rawPayload[0]).toBe(0x50); // 'P'
    expect(response.rawPayload[1]).toBe(0x4b); // 'K'
  });

  it("exporta PDF real com Content-Type e assinatura %PDF", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/export?relatorio=sla-aprovacao&formato=pdf&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain(".pdf");
    expect(response.rawPayload.length).toBeGreaterThan(500);
    expect(response.rawPayload.subarray(0, 4).toString("ascii")).toBe("%PDF");
  }, 20000);

  it("Gestor de Setor recebe 403 ao tentar exportar ranking-setores (Admin only)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/relatorios/export?relatorio=ranking-setores&formato=excel&dateFrom=${DATE_FROM}&dateTo=${DATE_TO}`,
      headers: { cookie: cookieGestorTi },
    });
    expect(response.statusCode).toBe(403);
  });
});
