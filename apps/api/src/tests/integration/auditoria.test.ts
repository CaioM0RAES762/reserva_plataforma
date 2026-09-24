import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S12 — RF-AUD-01/02: leitura e exportação em CSV do LogAuditoria (gravado desde S1,
// nunca lido via API até esta sprint).

const EMAIL_COLABORADOR = "teste.s12.auditoria.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S12-AUDITORIA";

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
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S12 Auditoria")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', NULL, 1, 1)`
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

  // Gera uma ação de auditoria real e conhecida para os testes de filtro/exportação.
  const criacao = await app.inject({
    method: "POST",
    url: "/api/v1/plataformas",
    headers: { cookie: cookieAdmin },
    payload: { codigo: CODIGO_PLATAFORMA, nome: "Plataforma de Teste S12 (auditoria)" },
  });
  expect(criacao.statusCode).toBe(201);
  plataformaId = criacao.json().id;
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().query(`DELETE FROM LogAuditoria WHERE entidade_id = '${plataformaId}'`);
  await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorId}'`);
  await app.close();
  await closePool();
});

describe("Auditoria (S12 — RF-AUD-01/02)", () => {
  it("Colaborador não acessa GET /auditoria (403)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auditoria",
      headers: { cookie: cookieColaborador },
    });
    expect(response.statusCode).toBe(403);
  });

  it("Admin consulta auditoria filtrando por entidade e encontra a ação criar_plataforma", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auditoria?entidade=Plataforma&acao=criar_plataforma`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const registros = response.json();
    expect(registros.some((r: { entidadeId: string }) => r.entidadeId === plataformaId)).toBe(true);

    // Projeção de recurso: sem ela, a tela só teria o UUID para identificar a plataforma
    // e voltaria a exibir um identificador técnico como informação principal.
    const registro = registros.find((r: { entidadeId: string }) => r.entidadeId === plataformaId);
    expect(registro.recursoNome).toBeTruthy();
    expect(registro.recursoCodigo).toBeTruthy();
    expect(registro).toHaveProperty("usuarioPerfil");
  });

  it("filtro por categoria agrupa os eventos de Frota sem exigir o código da ação", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auditoria?categoria=Frota`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const registros = response.json() as Array<{ acao: string }>;
    expect(registros.length).toBeGreaterThan(0);
    // Toda linha devolvida pertence de fato à categoria pedida.
    const acoesDeFrota = new Set([
      "criar_plataforma",
      "editar_plataforma",
      "alterar_status_plataforma",
      "criar_bloqueio",
      "remover_bloqueio",
    ]);
    for (const registro of registros) {
      expect(acoesDeFrota.has(registro.acao)).toBe(true);
    }
  });

  it("categoria inexistente é ignorada em vez de zerar a listagem", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auditoria?categoria=NaoExiste`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it("GATE S12 — GET /auditoria/export retorna CSV UTF-8 com BOM e cabeçalho esperado", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auditoria/export?entidade=Plataforma&acao=criar_plataforma`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    const corpo = response.body as string;
    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S12 — primeiras linhas do CSV de auditoria exportado ===");
    // eslint-disable-next-line no-console
    console.log(corpo.slice(0, 400));

    expect(corpo.charCodeAt(0)).toBe(0xfeff); // BOM UTF-8
    const semBom = corpo.slice(1);
    const linhas = semBom.split("\r\n");
    // O CSV passou a levar as colunas humanas primeiro (mesma nomenclatura da tela, via
    // @plataformares/shared) e a preservar as técnicas ao final — nada foi perdido: o
    // código interno da ação, a entidade, o UUID e o payload continuam exportados.
    expect(linhas[0]).toBe(
      "Data/Hora;Responsável;Perfil;Evento;Categoria;Recurso;Identificação do recurso;Alteração;" +
        "Código interno do evento;Tipo técnico;ID técnico;Payload"
    );
    // O evento aparece com o nome que o administrador lê na tela...
    expect(linhas.some((linha) => linha.includes("Plataforma cadastrada"))).toBe(true);
    // ...e o código interno continua presente, para rastreabilidade técnica.
    expect(linhas.some((linha) => linha.includes("criar_plataforma"))).toBe(true);
  });
});
