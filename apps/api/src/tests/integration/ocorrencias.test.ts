import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S11 — RF-RES-16/RN-PLAT-04: ocorrência de avaria reportada numa reserva; gravidade
// alta + gera_manutencao=1 muda Plataforma.status para 'manutencao' automaticamente
// (mesma transação) e passa a bloquear novas reservas nela até reversão manual do Admin.

const EMAIL_COLABORADOR = "teste.s11.colaborador@metalsider.com.br";
const EMAIL_COLABORADOR_OUTRO_SETOR = "teste.s11.outrosetor@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S11-OCORRENCIA";
const CODIGO_PLATAFORMA_2 = "PLT-S11-OCORRENCIA-2";
const DATA_RESERVA = "2026-11-20";

let app: FastifyInstance;
let setorTiId: string;
let setorOutroId: string;
let colaboradorId: string;
let colaboradorOutroSetorId: string;
let plataformaId: string;
let plataforma2Id: string;
let cookieColaborador: string;
let cookieColaboradorOutroSetor: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarEAprovarReserva(plataforma: string, horaInicio: string, horaFim: string): Promise<string> {
  const criacao = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaborador },
    payload: {
      plataformaId: plataforma,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      motivo: "Teste S11 — ocorrência",
      prioridade: "normal",
    },
  });
  expect(criacao.statusCode).toBe(201);
  const reservaId = criacao.json().id as string;

  const aprovacao = await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
  expect(aprovacao.statusCode).toBe(200);
  return reservaId;
}

async function limparDados() {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM Ocorrencia WHERE plataforma_id IN (
       SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_2}')
     )`
  );
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (
       SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_COLABORADOR_OUTRO_SETOR}')
     ) OR usuario_id IN (SELECT id FROM Usuario WHERE perfil = 'admin')`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_2}')
       )
     ) OR entidade_id IN (SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_2}'))`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (
       SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_2}')
     )`
  );
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA}', '${CODIGO_PLATAFORMA_2}')`);
  // LogAuditoria também é gravado com usuario_id = quem executou a ação (não só
  // entidade_id) — precisa ser limpo antes do DELETE de Usuario (mesmo padrão de S8).
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE usuario_id IN (
       SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_COLABORADOR_OUTRO_SETOR}')
     )`
  );
  await pool.request().query(
    `DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_COLABORADOR_OUTRO_SETOR}')`
  );
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparDados();

  const pool = await getPool();
  const setorTi = await pool.request().query<{ id: string }>("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorOutro = await pool
    .request()
    .query<{ id: string }>("SELECT TOP 1 id FROM Setor WHERE nome <> 'TI'");
  setorOutroId = setorOutro.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma Teste S11 — Ocorrência")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'patio', 'medio')`
    );
  plataformaId = plataforma.recordset[0].id;

  const plataforma2 = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_2)
    .input("nome", sql.NVarChar, "Plataforma Teste S11 — Ocorrência Leve")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'patio', 'medio')`
    );
  plataforma2Id = plataforma2.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S11")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const colaboradorOutro = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Outro Setor S11")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR_OUTRO_SETOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorOutroId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorOutroSetorId = colaboradorOutro.recordset[0].id;

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

  const loginColaboradorOutro = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR_OUTRO_SETOR, senha: SENHA },
  });
  expect(loginColaboradorOutro.statusCode).toBe(200);
  cookieColaboradorOutroSetor = extrairCookieToken(loginColaboradorOutro.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  await limparDados();
  await app.close();
  await closePool();
});

describe("POST /reservas/:id/ocorrencia — RF-RES-16/RN-PLAT-04", () => {
  it("gravidade alta + gera_manutencao=1 muda Plataforma.status para 'manutencao' e bloqueia nova reserva", async () => {
    const reservaId = await criarEAprovarReserva(plataformaId, "08:00", "09:00");

    const antes = await app.inject({ method: "GET", url: `/api/v1/plataformas?q=${CODIGO_PLATAFORMA}`, headers: { cookie: cookieAdmin } });
    expect(antes.json()[0].status).toBe("disponivel");

    const ocorrencia = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/ocorrencia`,
      headers: { cookie: cookieColaborador },
      payload: { descricao: "Estrutura com trinca visível após o uso.", gravidade: "alta", geraManutencao: true },
    });
    expect(ocorrencia.statusCode).toBe(201);
    expect(ocorrencia.json().geraManutencao).toBe(true);

    // Prova real: a plataforma mudou de status automaticamente (nenhum PATCH manual chamado).
    const depois = await app.inject({ method: "GET", url: `/api/v1/plataformas?q=${CODIGO_PLATAFORMA}`, headers: { cookie: cookieAdmin } });
    expect(depois.json()[0].status).toBe("manutencao");

    // Prova real: nova tentativa de reserva na mesma plataforma agora falha (RN-PLAT-04).
    const novaTentativa = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "10:00",
        horaFim: "11:00",
        motivo: "Tentativa após manutenção automática",
        prioridade: "normal",
      },
    });
    expect(novaTentativa.statusCode).toBe(409);
    expect(novaTentativa.json().erro).toMatch(/manuten[cç][aã]o/i);

    // Notificação in-app real ao Admin (gravidade alta).
    const notificacoesAdmin = await app.inject({ method: "GET", url: "/api/v1/notificacoes", headers: { cookie: cookieAdmin } });
    expect(
      notificacoesAdmin.json().some((n: { tipo: string; link: string }) => n.tipo === "ocorrencia_reportada" && n.link === `/reservas/${reservaId}`)
    ).toBe(true);
  });

  it("gravidade baixa + gera_manutencao=0 NÃO altera Plataforma.status", async () => {
    const reservaId = await criarEAprovarReserva(plataforma2Id, "09:00", "10:00");

    const ocorrencia = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/ocorrencia`,
      headers: { cookie: cookieColaborador },
      payload: { descricao: "Pequeno arranhão sem impacto estrutural.", gravidade: "baixa", geraManutencao: false },
    });
    expect(ocorrencia.statusCode).toBe(201);

    const depois = await app.inject({ method: "GET", url: `/api/v1/plataformas?q=${CODIGO_PLATAFORMA_2}`, headers: { cookie: cookieAdmin } });
    expect(depois.json()[0].status).toBe("disponivel");

    // Nova reserva na mesma plataforma continua permitida.
    const novaTentativa = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId: plataforma2Id,
        data: DATA_RESERVA,
        horaInicio: "11:00",
        horaFim: "12:00",
        motivo: "Nova reserva permitida (sem manutenção)",
        prioridade: "normal",
      },
    });
    expect(novaTentativa.statusCode).toBe(201);
  });

  it("usuário fora do escopo do setor da reserva recebe 403", async () => {
    // Usa plataforma2Id (permanece 'disponivel') — plataformaId já foi movida para
    // 'manutencao' pelo primeiro teste desta suíte (RN-PLAT-04), o que bloquearia esta
    // nova reserva antes mesmo de chegar à checagem de escopo que este teste cobre.
    const reservaId = await criarEAprovarReserva(plataforma2Id, "13:00", "14:00");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/ocorrencia`,
      headers: { cookie: cookieColaboradorOutroSetor },
      payload: { descricao: "Tentativa fora de escopo.", gravidade: "baixa", geraManutencao: false },
    });
    expect(response.statusCode).toBe(403);
  });
});
