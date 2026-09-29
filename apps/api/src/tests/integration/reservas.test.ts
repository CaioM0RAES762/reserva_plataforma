import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

const EMAIL_COLABORADOR_TI = "teste.reservas.ti@metalsider.com.br";
const EMAIL_COLABORADOR_MANUTENCAO = "teste.reservas.manutencao@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S3-TESTE";
// Relativa a "agora", não hardcoded: mesmo padrão do ADR-04 de S14 (ver dataDaqui em
// refinamento.test.ts) — a data fixa "2026-08-10" usada antes já virou passado com a
// passagem do tempo real, o que faria toda reserva desta suíte ser rejeitada por
// antecedência mínima (RN-RES-03), sem relação nenhuma com o que o teste verifica.
// Deslocamento aleatório evita colidir com reservas deixadas por execuções anteriores.
function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DATA_RESERVA = dataDaqui(400 + Math.floor(Math.random() * 300));

let app: FastifyInstance;
let setorTiId: string;
let setorManutencaoId: string;
let colaboradorTiId: string;
let colaboradorManutencaoId: string;
let plataformaId: string;
let cookieColaboradorTi: string;
let cookieColaboradorManutencao: string;
let cookieAdmin: string;
let reservaAId: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  // Limpeza defensiva de execuções anteriores que tenham falhado no meio do caminho.
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'))`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool
    .request()
    .query(
      `DELETE FROM Usuario WHERE email IN ('${EMAIL_COLABORADOR_TI}', '${EMAIL_COLABORADOR_MANUTENCAO}')`
    );

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;
  const setorManutencao = await pool.request().query("SELECT id FROM Setor WHERE nome = 'Manutenção'");
  setorManutencaoId = setorManutencao.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S3")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);

  const colaboradorTi = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador TI Teste S3")
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
    .input("nome", sql.NVarChar, "Colaborador Manutenção Teste S3")
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
  await pool.request().input("id", sql.UniqueIdentifier, plataformaId).query("DELETE FROM Plataforma WHERE id = @id");
  await pool
    .request()
    .query(
      `DELETE FROM LogAuditoria WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`
    );
  // FK_Notificacao_Usuario: os testes de capacidade/período abaixo aprovam reservas
  // (para não empilhar "pendente" e esbarrar em RN-RES-05), e aprovar gera uma
  // Notificacao para o solicitante — sem esta limpeza, o DELETE de Usuario falhava.
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`
    );
  await pool
    .request()
    .query(`DELETE FROM Usuario WHERE id IN ('${colaboradorTiId}', '${colaboradorManutencaoId}')`);
  await app.close();
  await closePool();
});

describe("Reservas (S3) — criação, conflito e escopo por setor", () => {
  it("Colaborador cria reserva A com sucesso (201, status pendente)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "10:00",
        quantidadePessoas: 1,
        motivo: "Manutenção preventiva do equipamento",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("pendente");
    expect(body.setorId).toBe(setorTiId);
    reservaAId = body.id;
  });

  it("GET /reservas reflete a reserva A criada", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaAId)).toBe(true);
  });

  it("Admin sem setor não pode criar reserva (422)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "11:00",
        horaFim: "12:00",
        quantidadePessoas: 1,
        motivo: "Teste sem setor",
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it("GET /reservas/conflitos detecta conflito com a reserva A para um horário sobreposto", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/conflitos?plataformaId=${plataformaId}&data=${DATA_RESERVA}&horaInicio=09:00&horaFim=11:00`,
      headers: { cookie: cookieColaboradorTi },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.conflito).toBe(true);
    expect(body.reserva.id).toBe(reservaAId);
  });

  it("POST /reservas rejeita reserva B conflitante na mesma plataforma/data (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "09:00",
        horaFim: "11:00",
        quantidadePessoas: 1,
        motivo: "Reserva conflitante — não deveria ser criada",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("Conflito de horário");
  });

  it("POST /reservas aceita reserva adjacente exata (início == fim da reserva A) — SEM conflito", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "10:00",
        horaFim: "11:30",
        quantidadePessoas: 1,
        motivo: "Reserva adjacente, sem sobreposição real",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("Colaborador de outro setor (Manutenção) vê a reserva A na listagem, com o motivo visível — reserva é informação operacional compartilhada", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; motivo: string; solicitanteId: string }>;
    const reservaA = body.find((r) => r.id === reservaAId);
    expect(reservaA).toBeDefined();
    expect(reservaA?.motivo).toBe("Manutenção preventiva do equipamento");
    expect(reservaA?.solicitanteId).toBeTruthy();
  });

  it("Colaborador de outro setor (Manutenção) LÊ e também pode COMENTAR na reserva A — conteúdo operacional compartilhado", async () => {
    const leitura = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaAId}/comentarios`,
      headers: { cookie: cookieColaboradorManutencao },
    });
    expect(leitura.statusCode).toBe(200);

    const escrita = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaAId}/comentarios`,
      headers: { cookie: cookieColaboradorManutencao },
      payload: { mensagem: "Comentário de colaborador de outro setor", tipo: "comentario", imagens: [] },
    });
    expect(escrita.statusCode).toBe(201);
  });

  it("Admin vê a reserva A mesmo sem pertencer ao setor TI", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas?data=${DATA_RESERVA}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string }>;
    expect(body.some((r) => r.id === reservaAId)).toBe(true);
  });
});

// S14 (bug real encontrado via E2E — RF-RES-01 lista Admin entre quem pode solicitar
// reserva, mas RN-USR-01 diz que Admin não possui setor_id próprio; antes desta sprint
// POST /reservas sempre derivava o setor da sessão, então todo Admin recebia 422
// ("Sua conta não está vinculada a um setor") ao tentar solicitar — Admin literalmente
// não conseguia usar UC-01. Corrigido: Admin agora informa `setorId` no body.
describe("Reservas (S14) — Admin solicita reserva escolhendo o setor de destino (RF-RES-01, RN-USR-01)", () => {
  it("Admin sem setorId no body recebe 422 pedindo para selecionar o setor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "14:00",
        horaFim: "15:00",
        quantidadePessoas: 1,
        motivo: "Reserva de Admin sem setor informado",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().erro).toMatch(/selecione o setor/i);
  });

  it("Admin com setorId no body cria a reserva vinculada a esse setor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieAdmin },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "15:00",
        horaFim: "16:00",
        quantidadePessoas: 1,
        motivo: "Reserva de Admin para o setor TI",
        setorId: setorTiId,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().setorId).toBe(setorTiId);
  });

  // Regra atual: o setor do usuário é só o padrão do "Setor solicitante" — o Colaborador
  // pode reservar para outro setor ativo (a API confere que o setor existe e está ativo).
  it("setorId informado no body por Colaborador define o setor solicitante da reserva", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorTi },
      payload: {
        plataformaId,
        data: DATA_RESERVA,
        horaInicio: "16:00",
        horaFim: "17:00",
        quantidadePessoas: 1,
        motivo: "Colaborador reservando para a Manutenção",
        setorId: setorManutencaoId,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().setorId).toBe(setorManutencaoId);
  });
});

// Corrigir/melhorar Reservas: quantidade de pessoas validada contra a capacidade
// oficial da plataforma, sempre lida do banco (nunca de um valor enviado pelo cliente).
describe("Reservas — quantidade de pessoas x capacidade da plataforma", () => {
  const CODIGO_PLATAFORMA_CAPACIDADE = "PLT-S3-CAPACIDADE";
  let plataformaComCapacidadeId: string;
  let plataformaSemCapacidadeId: string;

  // Aprova a reserva logo após criar: sem isto, cada 201 deste bloco fica "pendente" e
  // se acumula com os de outros describe() deste arquivo até estourar RN-RES-05
  // (max_pendentes_por_setor, padrão 5) — um limite real do sistema, não um bug, mas
  // que não tem nada a ver com o que estes testes verificam.
  async function aprovar(id: string): Promise<void> {
    const resposta = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${id}/aprovar`,
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(200);
  }

  beforeAll(async () => {
    const pool = await getPool();
    await pool
      .request()
      .query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_CAPACIDADE}', '${CODIGO_PLATAFORMA_CAPACIDADE}-2')`);
    // Bug de domínio corrigido: capacidade (kg, carga) e capacidade_operadores (pessoas)
    // são propositalmente DIFERENTES aqui — 500 kg x 4 pessoas, o mesmo exemplo do
    // problema relatado — para provar que QUANTIDADE DE PESSOAS nunca é validada contra o
    // campo de kg.
    const comCapacidade = await pool
      .request()
      .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_CAPACIDADE)
      .input("nome", sql.NVarChar, "Plataforma com Capacidade Definida")
      .input("capacidade", sql.Int, 500)
      .input("capacidade_operadores", sql.Int, 4)
      .query<{ id: string }>(
        `INSERT INTO Plataforma (codigo, nome, capacidade, capacidade_operadores)
         OUTPUT INSERTED.id VALUES (@codigo, @nome, @capacidade, @capacidade_operadores)`
      );
    plataformaComCapacidadeId = comCapacidade.recordset[0].id;

    // Capacidade de CARGA (kg) cadastrada, mas capacidade de PESSOAS não — a reserva não
    // pode inventar um teto de pessoas a partir do valor de kg.
    const semCapacidade = await pool
      .request()
      .input("codigo", sql.VarChar, `${CODIGO_PLATAFORMA_CAPACIDADE}-2`)
      .input("nome", sql.NVarChar, "Plataforma sem Capacidade de Pessoas Cadastrada")
      .input("capacidade", sql.Int, 300)
      .query<{ id: string }>(
        `INSERT INTO Plataforma (codigo, nome, capacidade) OUTPUT INSERTED.id VALUES (@codigo, @nome, @capacidade)`
      );
    plataformaSemCapacidadeId = semCapacidade.recordset[0].id;
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool
      .request()
      .query(
        `DELETE FROM Reserva WHERE plataforma_id IN ('${plataformaComCapacidadeId}', '${plataformaSemCapacidadeId}')`
      );
    await pool
      .request()
      .query(`DELETE FROM Plataforma WHERE id IN ('${plataformaComCapacidadeId}', '${plataformaSemCapacidadeId}')`);
  });

  it("rejeita quantidade de pessoas acima da capacidade cadastrada (409)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      // Manutenção (não TI): as reservas de TI acumuladas pelos blocos anteriores deste
      // arquivo já usam boa parte do limite de RN-RES-05 (max_pendentes_por_setor) —
      // usar outro setor evita que este bloco esbarre nesse limite por acidente.
      headers: { cookie: cookieColaboradorManutencao },
      payload: {
        plataformaId: plataformaComCapacidadeId,
        data: DATA_RESERVA,
        horaInicio: "08:00",
        horaFim: "09:00",
        quantidadePessoas: 5,
        motivo: "Quantidade acima da capacidade — não deveria ser criada",
      },
    });
    expect(response.statusCode).toBe(409);
    // A mensagem cita a capacidade de PESSOAS (4, capacidade_operadores) — nunca a
    // capacidade de carga em kg (500, capacidade) cadastrada na mesma plataforma.
    expect(response.json().erro).toMatch(/capacidade máxima para 4 pessoa/i);
    expect(response.json().erro).not.toMatch(/500/);
  });

  it("aceita quantidade de pessoas exatamente igual à capacidade cadastrada", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
      payload: {
        plataformaId: plataformaComCapacidadeId,
        data: DATA_RESERVA,
        horaInicio: "09:00",
        horaFim: "10:00",
        quantidadePessoas: 4,
        motivo: "Quantidade igual à capacidade — deve ser aceita",
      },
    });
    expect(response.statusCode).toBe(201);
    await aprovar(response.json().id);
  });

  it("não confia numa capacidade enviada pelo cliente — sempre busca a oficial no banco", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
      payload: {
        plataformaId: plataformaComCapacidadeId,
        data: DATA_RESERVA,
        horaInicio: "10:00",
        horaFim: "11:00",
        quantidadePessoas: 10,
        // Um valor de capacidade forjado no corpo da requisição não é um campo aceito
        // pelo schema (capacidadeMaxima nem existe em criarReservaSchema) — mesmo que
        // existisse, a rota nunca o leria; a capacidade vem exclusivamente do SELECT em
        // Plataforma. Este teste documenta essa garantia.
        capacidadeMaxima: 999,
        motivo: "Tentativa de forjar capacidade via corpo da requisição",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("plataforma com capacidade de kg mas sem capacidade de pessoas não bloqueia por um teto inventado a partir do kg", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
      payload: {
        plataformaId: plataformaSemCapacidadeId,
        data: DATA_RESERVA,
        horaInicio: "11:00",
        horaFim: "12:00",
        quantidadePessoas: 500,
        motivo: "Sem capacidade cadastrada — não deve ser bloqueada arbitrariamente",
      },
    });
    expect(response.statusCode).toBe(201);
    await aprovar(response.json().id);
  });

  it("rejeita quantidade de pessoas menor que 1 (validação de schema)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaboradorManutencao },
      payload: {
        plataformaId: plataformaComCapacidadeId,
        data: DATA_RESERVA,
        horaInicio: "12:00",
        horaFim: "13:00",
        quantidadePessoas: 0,
        motivo: "Quantidade zero — deve ser rejeitada",
      },
    });
    expect(response.statusCode).toBe(422);
  });
});

// Corrigir/melhorar Reservas: a listagem sempre filtra por intervalo real (dateFrom/
// dateTo) — antes a tela de Reservas carregava tudo sem filtro de período, o que fazia
// reservas de anos à frente aparecerem misturadas com as da semana atual.
describe("Reservas — filtro de período (dateFrom/dateTo) e ordenação cronológica", () => {
  const CODIGO_PLATAFORMA_PERIODO = "PLT-S3-PERIODO";
  let plataformaPeriodoId: string;
  const dataDentro1 = dataDaqui(500);
  const dataDentro2 = dataDaqui(505);
  const dataForaAntes = dataDaqui(490);
  const dataForaDepois = dataDaqui(520);

  beforeAll(async () => {
    const pool = await getPool();
    await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA_PERIODO}'`);
    const plataforma = await pool
      .request()
      .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_PERIODO)
      .input("nome", sql.NVarChar, "Plataforma de Teste — Período")
      .query<{ id: string }>(`INSERT INTO Plataforma (codigo, nome) OUTPUT INSERTED.id VALUES (@codigo, @nome)`);
    plataformaPeriodoId = plataforma.recordset[0].id;

    async function criar(data: string, horaInicio: string, horaFim: string, motivo: string) {
      const resposta = await app.inject({
        method: "POST",
        url: "/api/v1/reservas",
        headers: { cookie: cookieColaboradorManutencao },
        payload: { plataformaId: plataformaPeriodoId, data, horaInicio, horaFim, quantidadePessoas: 1, motivo },
      });
      expect(resposta.statusCode).toBe(201);
      // Aprova logo em seguida para não empilhar "pendente" e esbarrar em RN-RES-05
      // (max_pendentes_por_setor) — mesmo motivo do describe() de capacidade acima.
      const aprovacao = await app.inject({
        method: "POST",
        url: `/api/v1/reservas/${resposta.json().id}/aprovar`,
        headers: { cookie: cookieAdmin },
      });
      expect(aprovacao.statusCode).toBe(200);
    }
    // Fora do intervalo testado (antes) — não deve aparecer no resultado filtrado.
    await criar(dataForaAntes, "08:00", "09:00", "Fora do período — antes");
    // Dentro do intervalo, em ordem propositalmente “errada” de criação — a resposta
    // filtrada precisa vir ordenada cronologicamente, não por ordem de inserção.
    await criar(dataDentro2, "08:00", "09:00", "Dentro do período — segunda data");
    await criar(dataDentro1, "08:00", "09:00", "Dentro do período — primeira data");
    // Fora do intervalo testado (depois).
    await criar(dataForaDepois, "08:00", "09:00", "Fora do período — depois");
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.request().query(`DELETE FROM Reserva WHERE plataforma_id = '${plataformaPeriodoId}'`);
    await pool.request().query(`DELETE FROM Plataforma WHERE id = '${plataformaPeriodoId}'`);
  });

  it("retorna só as reservas dentro de [dateFrom, dateTo], em ordem cronológica", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas?dateFrom=${dataDentro1}&dateTo=${dataDentro2}`,
      headers: { cookie: cookieAdmin },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ plataformaId: string; data: string; motivo: string }>;
    const desteTeste = body.filter((r) => r.plataformaId === plataformaPeriodoId);
    expect(desteTeste.map((r) => r.data)).toEqual([dataDentro1, dataDentro2]);
    expect(desteTeste.some((r) => r.data === dataForaAntes)).toBe(false);
    expect(desteTeste.some((r) => r.data === dataForaDepois)).toBe(false);
  });
});
