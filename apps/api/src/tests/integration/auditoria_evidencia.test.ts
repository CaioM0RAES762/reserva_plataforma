import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// Sprint S6 — Gate de Aceite: evidência real de que LogAuditoria é populado para cada
// tipo de ação já implementada em S1-S5 (RN-AUD-01). Este teste exercita, via API real
// (não mock), uma ocorrência de cada ação sensível e, ao final, consulta LogAuditoria
// diretamente para provar a gravação. Toda a evidência (contagens e linhas) é impressa
// no stdout do teste para ser colada no relatório da sprint.

const EMAIL_COLABORADOR = "teste.auditoria.s6@metalsider.com.br";
const EMAIL_ATIVACAO = "teste.auditoria.ativacao.s6@metalsider.com.br";
const CODIGO_ATIVACAO = "913275";
const CODIGO_RESET = "204817";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S6-AUDIT";
const DATA_RESERVA = "2026-10-01";

let app: FastifyInstance;
let setorId: string;
let colaboradorId: string;
let usuarioAtivacaoId: string;
let plataformaId: string;
let cookieAdmin: string;
let cookieColaborador: string;
let reservaAId: string;
let reservaBId: string;
let reservaCId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(
      `DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_ATIVACAO}'))`
    );
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_ATIVACAO}'))`
    );
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_ATIVACAO}'))`
    );
  await pool.request().query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR}', '${EMAIL_ATIVACAO}')`);

  const setor = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Qualidade'");
  setorId = setor.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Auditoria Teste S6")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const senhaPlaceholder = await hashPassword("placeholder-nao-utilizavel");
  const usuarioAtivacao = await pool
    .request()
    .input("nome", sql.NVarChar, "Usuário Ativação Auditoria S6")
    .input("email", sql.NVarChar, EMAIL_ATIVACAO)
    .input("senha_hash", sql.VarChar, senhaPlaceholder)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', NULL, 1, 0)`
    );
  usuarioAtivacaoId = usuarioAtivacao.recordset[0].id;

  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioAtivacaoId)
    .input("codigo", sql.Char(6), CODIGO_ATIVACAO)
    .input("tipo", sql.VarChar, "ativacao_conta")
    .input("expira_em", sql.DateTime2, new Date(Date.now() + 15 * 60 * 1000))
    .query(
      `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
       VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
    );

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
    .query(`DELETE FROM LogAuditoria WHERE usuario_id IN ('${colaboradorId}', '${usuarioAtivacaoId}')`);
  await pool
    .request()
    .query(`DELETE FROM CodigoVerificacao WHERE usuario_id IN ('${colaboradorId}', '${usuarioAtivacaoId}')`);
  await pool
    .request()
    .query(`DELETE FROM Notificacao WHERE usuario_id IN ('${colaboradorId}', '${usuarioAtivacaoId}')`);
  await pool.request().query(`DELETE FROM Usuario WHERE id IN ('${colaboradorId}', '${usuarioAtivacaoId}')`);
  await app.close();
  await closePool();
});

describe("Auditoria (S6) — evidência real de LogAuditoria populado para cada tipo de ação", () => {
  it("exercita uma ocorrência real de cada ação sensível via API", async () => {
    // criar_plataforma
    const criarPlataforma = await app.inject({
      method: "POST",
      url: "/api/v1/plataformas",
      headers: { cookie: cookieAdmin },
      payload: { codigo: CODIGO_PLATAFORMA, nome: "Plataforma de Evidência de Auditoria S6" },
    });
    expect(criarPlataforma.statusCode).toBe(201);
    plataformaId = criarPlataforma.json().id;

    // editar_plataforma
    const editarPlataforma = await app.inject({
      method: "PUT",
      url: `/api/v1/plataformas/${plataformaId}`,
      headers: { cookie: cookieAdmin },
      payload: { codigo: CODIGO_PLATAFORMA, nome: "Plataforma de Evidência de Auditoria S6 (editada)" },
    });
    expect(editarPlataforma.statusCode).toBe(200);

    // alterar_status_plataforma
    const alterarStatus = await app.inject({
      method: "PATCH",
      url: `/api/v1/plataformas/${plataformaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { status: "disponivel" },
    });
    expect(alterarStatus.statusCode).toBe(200);

    // criar_reserva (A) -> aprovar_reserva -> iniciar_uso_reserva -> concluir_reserva
    const criarReservaA = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "09:00",
        motivo: "Reserva de evidência de auditoria (fluxo completo)",
        prioridade: "normal",
      },
    });
    expect(criarReservaA.statusCode).toBe(201);
    reservaAId = criarReservaA.json().id;

    const aprovar = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaAId}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(aprovar.statusCode).toBe(200);

    const iniciarUso = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaAId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(iniciarUso.statusCode).toBe(200);

    const concluir = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaAId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "concluir" },
    });
    expect(concluir.statusCode).toBe(200);

    // criar_reserva (B) -> rejeitar_reserva
    const criarReservaB = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "10:00",
        horaFim: "11:00",
        motivo: "Reserva de evidência de auditoria (fluxo de rejeição)",
        prioridade: "normal",
      },
    });
    expect(criarReservaB.statusCode).toBe(201);
    reservaBId = criarReservaB.json().id;

    const rejeitar = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaBId}/rejeitar`,
      headers: { cookie: cookieAdmin },
      payload: { motivo: "Rejeitada para fins de evidência de auditoria" },
    });
    expect(rejeitar.statusCode).toBe(200);

    // criar_reserva (C) -> cancelar_reserva
    const criarReservaC = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "12:00",
        horaFim: "13:00",
        motivo: "Reserva de evidência de auditoria (fluxo de cancelamento)",
        prioridade: "normal",
      },
    });
    expect(criarReservaC.statusCode).toBe(201);
    reservaCId = criarReservaC.json().id;

    const cancelar = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaCId}/cancelar`,
      headers: { cookie: cookieColaborador },
    });
    expect(cancelar.statusCode).toBe(200);

    // trocar_senha
    const trocarSenha = await app.inject({
      method: "PATCH",
      url: "/api/v1/conta/senha",
      headers: { cookie: cookieColaborador },
      payload: { senhaAtual: SENHA, novaSenha: "NovaSenhaAuditoria789" },
    });
    expect(trocarSenha.statusCode).toBe(200);

    // ativar_conta
    const ativarConta = await app.inject({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_ATIVACAO, codigo: CODIGO_ATIVACAO, senha: SENHA },
    });
    expect(ativarConta.statusCode).toBe(200);

    // redefinir_senha (reaproveita o mesmo usuário, agora já ativo)
    const pool = await getPool();
    await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuarioAtivacaoId)
      .input("codigo", sql.Char(6), CODIGO_RESET)
      .input("tipo", sql.VarChar, "reset_senha")
      .input("expira_em", sql.DateTime2, new Date(Date.now() + 15 * 60 * 1000))
      .query(
        `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
         VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
      );
    const redefinirSenha = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recuperar-senha/confirmar",
      payload: { email: EMAIL_ATIVACAO, codigo: CODIGO_RESET, novaSenha: "OutraSenhaAuditoria456" },
    });
    expect(redefinirSenha.statusCode).toBe(200);
  });

  it("QUERY REAL — LogAuditoria populado para cada tipo de ação (RN-AUD-01)", async () => {
    const pool = await getPool();
    const idsRelevantes = [
      plataformaId,
      reservaAId,
      reservaBId,
      reservaCId,
      colaboradorId,
      usuarioAtivacaoId,
    ];

    const contagemPorAcao = await pool.request().query<{ acao: string; total: number }>(
      `SELECT acao, COUNT(*) AS total
       FROM LogAuditoria
       WHERE entidade_id IN ('${idsRelevantes.join("','")}')
       GROUP BY acao
       ORDER BY acao`
    );

    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S6 — LogAuditoria agrupado por ação (query real) ===");
    // eslint-disable-next-line no-console
    console.table(contagemPorAcao.recordset);

    const linhasDetalhadas = await pool.request().query(
      `SELECT TOP 20 acao, entidade, entidade_id, usuario_id, criado_em
       FROM LogAuditoria
       WHERE entidade_id IN ('${idsRelevantes.join("','")}')
       ORDER BY criado_em ASC`
    );
    // eslint-disable-next-line no-console
    console.log("\n=== EVIDÊNCIA S6 — Linhas reais de LogAuditoria (ordem cronológica) ===");
    // eslint-disable-next-line no-console
    console.table(linhasDetalhadas.recordset);

    const acoesEsperadas = [
      "ativar_conta",
      "redefinir_senha",
      "trocar_senha",
      "criar_plataforma",
      "editar_plataforma",
      "alterar_status_plataforma",
      "criar_reserva",
      "aprovar_reserva",
      "rejeitar_reserva",
      "iniciar_uso_reserva",
      "concluir_reserva",
      "cancelar_reserva",
    ];
    const acoesEncontradas = contagemPorAcao.recordset.map((r) => r.acao);
    for (const acao of acoesEsperadas) {
      expect(acoesEncontradas).toContain(acao);
    }
    expect(contagemPorAcao.recordset.length).toBe(acoesEsperadas.length);
  });
});
