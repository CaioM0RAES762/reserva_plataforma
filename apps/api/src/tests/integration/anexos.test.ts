import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S11 — RF-RES-14: anexos (foto/PDF/ART) por reserva, escopo de setor, validação real de
// mime via magic bytes e acesso de leitura só via SAS de curta duração (RNF-09).

const EMAIL_COLABORADOR = "teste.s11.anexos@metalsider.com.br";
const EMAIL_OUTRO_SETOR = "teste.s11.anexos.outro@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S11-ANEXO";
const DATA_RESERVA = "2026-11-21";

// PNG mínimo válido (1x1 pixel) — magic bytes reais.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let app: FastifyInstance;
let setorTiId: string;
let setorOutroId: string;
let colaboradorId: string;
let outroSetorId: string;
let plataformaId: string;
let reservaId: string;
let cookieColaborador: string;
let cookieOutroSetor: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function limparDados() {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM Anexo WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`
  );
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  // LogAuditoria também é gravado com usuario_id = quem executou a ação (não só
  // entidade_id) — precisa ser limpo antes do DELETE de Usuario (mesmo padrão de S8).
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE usuario_id IN (
       SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_OUTRO_SETOR}')
     )`
  );
  await pool.request().query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_OUTRO_SETOR}')`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparDados();

  const pool = await getPool();
  const setorTi = await pool.request().query<{ id: string }>("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorOutro = await pool.request().query<{ id: string }>("SELECT TOP 1 id FROM Setor WHERE nome <> 'TI'");
  setorOutroId = setorOutro.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma Teste S11 — Anexos")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S11 Anexos")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const outro = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Outro Setor Anexos")
    .input("email", sql.NVarChar, EMAIL_OUTRO_SETOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorOutroId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  outroSetorId = outro.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginColaborador = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR, senha: SENHA },
  });
  cookieColaborador = extrairCookieToken(loginColaborador.cookies.map((c) => `${c.name}=${c.value}`));

  const loginOutro = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_OUTRO_SETOR, senha: SENHA },
  });
  cookieOutroSetor = extrairCookieToken(loginOutro.cookies.map((c) => `${c.name}=${c.value}`));

  const criacao = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaborador },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio: "08:00",
      horaFim: "09:00",
      motivo: "Teste S11 — anexos",
      prioridade: "normal",
    },
  });
  reservaId = criacao.json().id as string;
});

afterAll(async () => {
  await limparDados();
  await app.close();
  await closePool();
});

describe("POST /reservas/:id/anexos — RF-RES-14/SDD §12", () => {
  it("envia um PNG real e o anexo fica acessível via URL com SAS assinado", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/anexos`,
      headers: { cookie: cookieColaborador },
      payload: { nomeArquivo: "evidencia.png", arquivoBase64: `data:image/png;base64,${PNG_BASE64}` },
    });
    expect(response.statusCode).toBe(201);
    const anexo = response.json();
    expect(anexo.tipoMime).toBe("image/png");
    expect(anexo.url).toContain("sig=");

    const arquivo = await fetch(anexo.url);
    expect(arquivo.status).toBe(200);
    const bytes = Buffer.from(await arquivo.arrayBuffer());
    expect(bytes.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
  });

  it("rejeita mime declarado mentindo sobre o conteúdo real (texto disfarçado de imagem) -> 422", async () => {
    const textoBase64 = Buffer.from("isto e apenas texto, nao uma imagem").toString("base64");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/anexos`,
      headers: { cookie: cookieColaborador },
      payload: { nomeArquivo: "fake.png", arquivoBase64: `data:image/png;base64,${textoBase64}` },
    });
    expect(response.statusCode).toBe(422);
  });

  it("usuário fora do escopo do setor recebe 403", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/anexos`,
      headers: { cookie: cookieOutroSetor },
      payload: { nomeArquivo: "evidencia.png", arquivoBase64: `data:image/png;base64,${PNG_BASE64}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("GET lista os anexos da reserva com URL de leitura válida", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/anexos`,
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(200);
    const lista = response.json();
    expect(lista.length).toBeGreaterThanOrEqual(1);
    expect(lista[0].url).toContain("sig=");
  });
});
