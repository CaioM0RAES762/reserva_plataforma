import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";
import { verificarEscalonamentoSla } from "../../services/escalonamento.service.js";

// S7 — RN-RES-09: reserva urgente sem decisão dentro do SLA configurado
// (sla_aprovacao_urgente_horas) é escalada automaticamente ao Admin. Como o job real é
// um BullMQ repeatable a cada 15 min, o "controle de tempo" do teste é feito
// retroagindo `Reserva.criado_em` diretamente no banco (em vez de esperar o SLA real).

const EMAIL_COLABORADOR = "teste.s7.escalonamento@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S7-ESCALON";
const DATA_RESERVA = "2026-10-06";

let app: FastifyInstance;
let colaboradorId: string;
let plataformaId: string;
let cookieColaborador: string;
let slaHorasConfigurado: number;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReservaUrgente(horaInicio: string, horaFim: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaborador },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      motivo: "Teste S7 — escalonamento de SLA",
      prioridade: "urgente",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function retrocederCriacao(reservaId: string, horasAtras: number): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, reservaId)
    .input("horas", sql.Int, horasAtras)
    .query("UPDATE Reserva SET criado_em = DATEADD(HOUR, -@horas, SYSUTCDATETIME()) WHERE id = @id");
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
    .input("nome", sql.NVarChar, "Plataforma de Teste S7 (escalonamento)")
    .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S7 Escalonamento")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR, senha: SENHA },
  });
  expect(login.statusCode).toBe(200);
  cookieColaborador = extrairCookieToken(login.cookies.map((c) => `${c.name}=${c.value}`));

  const slaResult = await pool
    .request()
    .query<{ valor: string }>("SELECT valor FROM ConfiguracaoSistema WHERE chave = 'sla_aprovacao_urgente_horas'");
  slaHorasConfigurado = Number(slaResult.recordset[0].valor);
});

afterAll(async () => {
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

describe("Escalonamento de SLA (RN-RES-09) — job de verificação", () => {
  it(`sla_aprovacao_urgente_horas está configurado em ConfiguracaoSistema (seed S7)`, () => {
    expect(slaHorasConfigurado).toBeGreaterThan(0);
  });

  it("reserva urgente recém-criada (dentro do SLA) NÃO é escalada", async () => {
    const reservaId = await criarReservaUrgente("08:00", "09:00");
    const escaladas = await verificarEscalonamentoSla();
    expect(escaladas).not.toContain(reservaId);
  });

  it("reserva urgente pendente além do SLA é escalada: dispara notificação e grava LogAuditoria", async () => {
    const reservaId = await criarReservaUrgente("09:00", "10:00");
    await retrocederCriacao(reservaId, slaHorasConfigurado + 1);

    const escaladas = await verificarEscalonamentoSla();
    expect(escaladas).toContain(reservaId);

    const pool = await getPool();
    const logResult = await pool
      .request()
      .input("id", sql.UniqueIdentifier, reservaId)
      .query<{ acao: string; usuario_id: string | null }>(
        `SELECT acao, usuario_id FROM LogAuditoria
         WHERE entidade = 'Reserva' AND entidade_id = @id AND acao = 'escalonar_sla_urgente'`
      );
    expect(logResult.recordset).toHaveLength(1);
    expect(logResult.recordset[0].usuario_id).toBeNull(); // ação disparada pelo sistema (ADR de S1)
  });

  it("a mesma reserva não é escalada de novo numa segunda execução do job (idempotência)", async () => {
    const reservaId = await criarReservaUrgente("10:00", "11:00");
    await retrocederCriacao(reservaId, slaHorasConfigurado + 1);

    const primeiraExecucao = await verificarEscalonamentoSla();
    expect(primeiraExecucao).toContain(reservaId);

    const segundaExecucao = await verificarEscalonamentoSla();
    expect(segundaExecucao).not.toContain(reservaId);
  });

  it("reserva urgente já aprovada (fora de pendente) não é escalada mesmo além do SLA", async () => {
    const reservaId = await criarReservaUrgente("11:00", "12:00");
    await retrocederCriacao(reservaId, slaHorasConfigurado + 1);

    const cancelamento = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/cancelar`,
      headers: { cookie: cookieColaborador },
    });
    expect(cancelamento.statusCode).toBe(200);

    const escaladas = await verificarEscalonamentoSla();
    expect(escaladas).not.toContain(reservaId);
  });
});
