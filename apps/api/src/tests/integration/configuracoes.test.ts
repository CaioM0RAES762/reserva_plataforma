import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S12 — RF-CFG-01/02: Admin parametriza as regras de agendamento. Gate de Aceite:
// alterar duracao_maxima_horas via PUT /configuracoes deve refletir imediatamente na
// validação de POST /reservas, sem reiniciar o servidor (prova de que o cache leve em
// configuracao.service.ts é invalidado corretamente ao salvar).

const EMAIL_COLABORADOR = "teste.s12.configuracoes@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S12-CONFIG";
const DATA_RESERVA = "2026-11-02";

let app: FastifyInstance;
let colaboradorId: string;
let plataformaId: string;
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

  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  const setorTiId = setorTi.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S12 (configurações)")
    .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S12 Configurações")
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
  // Restaura o padrão do seed (SDD §17.10), independentemente do resultado dos testes.
  await app.inject({
    method: "PUT",
    url: "/api/v1/configuracoes",
    headers: { cookie: cookieAdmin },
    payload: { duracaoMaximaHoras: 12 },
  });

  const pool = await getPool();
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id = '${plataformaId}')`);
  await pool.request().query(`DELETE FROM Reserva WHERE plataforma_id = '${plataformaId}'`);
  await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorId}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorId}'`);
  await app.close();
  await closePool();
});

describe("Configurações do Sistema (S12 — RF-CFG-01/02)", () => {
  it("Colaborador não acessa GET /configuracoes (403)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin lista as 6 chaves de ConfiguracaoSistema (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const chaves = response.json().map((c: { chave: string }) => c.chave);
    expect(chaves.sort()).toEqual(
      [
        "antecedencia_minima_horas",
        "duracao_maxima_horas",
        "horario_expediente_fim",
        "horario_expediente_inicio",
        "max_pendentes_por_setor",
        "sla_aprovacao_urgente_horas",
      ].sort()
    );
  });

  it("Colaborador não pode alterar configurações (403)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieColaborador },
      payload: { duracaoMaximaHoras: 4 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("PUT /configuracoes rejeita payload vazio (422)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieAdmin },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
  });

  it("GATE S12 — reserva de 3h é aceita com duracao_maxima_horas=12 (baseline)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "11:00",
        motivo: "Reserva de 3h — dentro do limite padrão de 12h",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("GATE S12 — alterar duracao_maxima_horas via PUT /configuracoes e comprovar rejeição IMEDIATA (sem reiniciar o servidor) de reserva acima do novo limite", async () => {
    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S12 — PUT /configuracoes (duracaoMaximaHoras: 2) ===");
    const atualizacao = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieAdmin },
      payload: { duracaoMaximaHoras: 2 },
    });
    expect(atualizacao.statusCode).toBe(200);
    const configAtualizada = atualizacao.json().find((c: { chave: string }) => c.chave === "duracao_maxima_horas");
    // eslint-disable-next-line no-console
    console.table([configAtualizada]);
    expect(configAtualizada.valor).toBe("2");

    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S12 — POST /reservas de 3h, MESMO PROCESSO, SEM RESTART ===");
    const tentativa = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "13:00",
        horaFim: "16:00",
        motivo: "Reserva de 3h — deveria ser rejeitada após o novo limite de 2h",
        prioridade: "normal",
      },
    });
    // eslint-disable-next-line no-console
    console.log({ statusCode: tentativa.statusCode, corpo: tentativa.json() });
    expect(tentativa.statusCode).toBe(409);
    expect(tentativa.json().erro).toContain("2 hora(s)");
  });

  it("GATE S12 — reserva de 2h volta a ser aceita após restaurar duracao_maxima_horas=12 (mesma sessão)", async () => {
    const restauracao = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: cookieAdmin },
      payload: { duracaoMaximaHoras: 12 },
    });
    expect(restauracao.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "13:00",
        horaFim: "16:00",
        motivo: "Reserva de 3h — aceita novamente após restaurar o limite padrão",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("PUT /configuracoes grava LogAuditoria (RN-AUD-01) para a ação atualizar_configuracao", async () => {
    const pool = await getPool();
    const logs = await pool
      .request()
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM LogAuditoria WHERE acao = 'atualizar_configuracao' AND entidade = 'ConfiguracaoSistema'"
      );
    expect(logs.recordset[0].total).toBeGreaterThan(0);
  });
});
