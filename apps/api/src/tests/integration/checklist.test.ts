import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// A finalizacao de checklist com nao conformidade notifica TODOS os Admin ativos, e o banco
// de desenvolvimento tem enderecos reais. Com o modulo da fila substituido por um duble,
// rodar esta suite nao coloca mensagem alguma na fila nem toca em SMTP.
vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const { hashPassword } = await import("../../utils/password.js");

// Correção do fluxo de Checklist: o checklist de segurança agora é portão da APROVAÇÃO
// (RF-CHK-06/RN-CHK-03), não mais do início de uso — uma reserva fica "pendente" até o
// checklist ser finalizado E conforme; só então pode ser aprovada. Categoria elevatória/
// andaime continuam exigindo checklist via o template padrão migrado (0016); "sala" segue
// sem exigência.

const EMAIL_COLABORADOR = "teste.s8.colaborador@metalsider.com.br";
// Admin proprio deste arquivo, criado via SQL no beforeAll. Antes o login usava
// process.env.SEED_ADMIN_EMAIL/PASSWORD: variaveis que nao existem no ambiente, entao o
// login devolvia 422, o beforeAll estourava e TODOS os testes deste arquivo ficavam
// "skipped" em silencio — exatamente por isso a regressao do fluxo de checklist passou
// despercebida. A suite agora provisiona o proprio Admin e roda de fato.
const EMAIL_ADMIN = "teste.s8.adm@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA_ELEVATORIA = "PLT-S8-ELEV";
const CODIGO_PLATAFORMA_SALA = "PLT-S8-SALA";
const NOME_TEMPLATE = "Template Teste S8 — Elevatória";
const DATA_RESERVA = "2026-11-10";

let app: FastifyInstance;
let setorTiId: string;
let colaboradorId: string;
let plataformaElevatoriaId: string;
let plataformaSalaId: string;
let cookieColaborador: string;
let cookieAdmin: string;
let itensTemplateElevatoria: { id: string; obrigatorio: boolean }[];
let templateElevatoriaId: string;
let horaSeq = 8; // cada teste usa um horário novo (08:00, 09:00, ...) para não colidir.

function proximoHorario(): { horaInicio: string; horaFim: string } {
  const inicio = horaSeq;
  horaSeq += 1;
  return { horaInicio: `${String(inicio).padStart(2, "0")}:00`, horaFim: `${String(inicio + 1).padStart(2, "0")}:00` };
}

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

async function criarReserva(plataformaId: string): Promise<string> {
  const { horaInicio, horaFim } = proximoHorario();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaborador },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      quantidadePessoas: 1,
      motivo: "Teste S8 — checklist de segurança",
      prioridade: "normal",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function aprovar(reservaId: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
}

// RN-RES-05 (max_pendentes_por_setor, default 5): vários testes aqui criam uma reserva e
// deliberadamente NÃO a aprovam (é o próprio bloqueio sendo testado) — sem isto, elas se
// acumulam como "pendente" no setor TI e o limite estoura no meio da suíte, quebrando
// testes que nada têm a ver com o que está sendo verificado. Rejeitar (não conta mais como
// pendente) não passa pelo gate de checklist, então serve de limpeza aqui.
async function encerrarComoPendenteDeSobra(reservaId: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/rejeitar`,
    headers: { cookie: cookieAdmin },
    payload: { motivo: "Encerrada pelo próprio teste (limpeza de fixture)." },
  });
}

function respostasTodasConformes() {
  return itensTemplateElevatoria.map((item) => ({ itemId: item.id, resultado: "conforme" as const }));
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const pool = await getPool();

  await pool.request().query(
    `DELETE FROM ChecklistResposta WHERE checklist_preenchido_id IN (
       SELECT id FROM ChecklistPreenchido WHERE reserva_id IN (
         SELECT id FROM Reserva WHERE plataforma_id IN (
           SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
         )
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (
         SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM Reserva WHERE plataforma_id IN (
       SELECT id FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE codigo IN ('${CODIGO_PLATAFORMA_ELEVATORIA}', '${CODIGO_PLATAFORMA_SALA}')`);
  await pool
    .request()
    .query(`DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_COLABORADOR}')`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  // A exigencia de checklist e uma CONFIGURACAO da plataforma (exige_checklist +
  // checklist_template_id), nao mais uma consequencia da categoria. O template proprio da
  // suite, com as 6 questoes do SDD, torna o fixture independente do que existe seedado.
  const templateSuite = await pool
    .request()
    .input("nome", sql.NVarChar, NOME_TEMPLATE)
    .query<{ id: string }>(
      `INSERT INTO ChecklistTemplate (nome, categoria_plataforma) OUTPUT INSERTED.id
       VALUES (@nome, 'elevatoria')`
    );
  templateElevatoriaId = templateSuite.recordset[0].id;
  const QUESTOES = [
    'Guarda-corpo e rodapé instalados e íntegros',
    'Sistema de freio/travamento testado',
    'Ausência de vazamentos hidráulicos visíveis',
    'Sinalização de área e isolamento realizados',
    'EPI do operador conforme (capacete, cinto, botina)',
    'Carga a transportar dentro do limite de capacidade da plataforma',
  ];
  for (const [indice, descricao] of QUESTOES.entries()) {
    await pool
      .request()
      .input("template_id", sql.UniqueIdentifier, templateElevatoriaId)
      .input("descricao", sql.NVarChar, descricao)
      .input("ordem", sql.Int, indice + 1)
      .query(
        `INSERT INTO ChecklistItemTemplate (template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao)
         VALUES (@template_id, @descricao, @ordem, 1, 1)`
      );
  }

  const plataformaElevatoria = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_ELEVATORIA)
    .input("nome", sql.NVarChar, "Plataforma Elevatória de Teste S8")
    .input("template_id", sql.UniqueIdentifier, templateElevatoriaId)
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco, exige_checklist, checklist_template_id)
       OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'elevatoria', 'alto', 1, @template_id)`
    );
  plataformaElevatoriaId = plataformaElevatoria.recordset[0].id;

  const plataformaSala = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA_SALA)
    .input("nome", sql.NVarChar, "Sala de Teste S8 (sem checklist)")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id
       VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaSalaId = plataformaSala.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S8")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_ADMIN}'`);
  await pool
    .request()
    .input("nome", sql.NVarChar, "Admin Teste S8")
    .input("email", sql.NVarChar, EMAIL_ADMIN)
    .input("senha_hash", sql.VarChar, senhaHash)
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       VALUES (@nome, @email, @senha_hash, 'admin', NULL, 1, 1)`
    );

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_ADMIN, senha: SENHA },
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

  const templates = await app.inject({
    method: "GET",
    url: `/api/v1/checklist-modelos/${templateElevatoriaId}`,
    headers: { cookie: cookieAdmin },
  });
  expect(templates.statusCode).toBe(200);
  itensTemplateElevatoria = templates.json().itens;
});

afterAll(async () => {
  const pool = await getPool();
  await pool.request().query(
    `DELETE FROM ChecklistResposta WHERE checklist_preenchido_id IN (
       SELECT id FROM ChecklistPreenchido WHERE reserva_id IN (
         SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
       )
     )`
  );
  await pool.request().query(
    `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
     )`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')`);
  await pool
    .request()
    .query(`DELETE FROM Plataforma WHERE id IN ('${plataformaElevatoriaId}', '${plataformaSalaId}')`);
  await pool
    .request()
    .query(`DELETE FROM ChecklistItemTemplate WHERE template_id IN (SELECT id FROM ChecklistTemplate WHERE nome = '${NOME_TEMPLATE}')`);
  await pool.request().query(`DELETE FROM ChecklistTemplate WHERE nome = '${NOME_TEMPLATE}'`);
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id = '${colaboradorId}'`);
  await pool.request().query(`DELETE FROM Notificacao WHERE usuario_id = '${colaboradorId}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE id = '${colaboradorId}'`);
  await pool.request().query(`DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_ADMIN}')`);
  await pool.request().query(`DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_ADMIN}')`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_ADMIN}'`);
  await app.close();
  await closePool();
});

describe("GET /checklist-modelos/:id — RF-CHK-01", () => {
  it("o template da plataforma tem 6 itens, todos obrigatórios (SDD §17.9)", () => {
    expect(itensTemplateElevatoria.length).toBe(6);
    expect(itensTemplateElevatoria.every((i) => i.obrigatorio)).toBe(true);
  });
});

describe("GET /reservas/:id/checklist — plataforma sem exigência de checklist", () => {
  it("plataforma sem exige_checklist -> requerChecklist=false, sem itens, aprova direto", async () => {
    const reservaId = await criarReserva(plataformaSalaId);
    const consulta = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
    });
    expect(consulta.statusCode).toBe(200);
    const body = consulta.json();
    expect(body.requerChecklist).toBe(false);
    expect(body.itens).toEqual([]);

    const aprovacao = await aprovar(reservaId);
    expect(aprovacao.statusCode).toBe(200);
    expect(aprovacao.json().status).toBe("agendada");
  });
});

describe("PUT /reservas/:id/checklist — salvar rascunho (RF-CHK-06)", () => {
  it("item não conforme sem observação -> 422 mesmo em rascunho (RN-CHK-01 vale sempre)", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: [{ itemId: itensTemplateElevatoria[0].id, resultado: "nao_conforme" }] },
    });
    expect(response.statusCode).toBe(422);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("resposta parcial (3 de 6 itens) -> 200, não finaliza (RF-CHK-06)", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const respostasParciais = itensTemplateElevatoria
      .slice(0, 3)
      .map((item) => ({ itemId: item.id, resultado: "conforme" as const }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasParciais },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().finalizado).toBe(false);

    const consulta = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
    });
    const body = consulta.json();
    expect(body.finalizadoEm).toBeNull();
    expect(body.totalRespondidos).toBe(3);
    expect(body.totalItens).toBe(6);
    expect(body.todosConformes).toBeNull();
    await encerrarComoPendenteDeSobra(reservaId);
  });
});

describe("POST /reservas/:id/checklist/finalizar — RF-CHK-06/RN-CHK-03", () => {
  it("item obrigatório sem resposta -> 422", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const respostasIncompletas = itensTemplateElevatoria
      .slice(0, 5)
      .map((item) => ({ itemId: item.id, resultado: "conforme" as const }));

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasIncompletas },
    });
    expect(response.statusCode).toBe(422);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("todos os itens conformes -> 200, finalizado=true, todosConformes=true", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasTodasConformes() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ finalizado: true, todosConformes: true });

    const consulta = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
    });
    const body = consulta.json();
    expect(body.requerChecklist).toBe(true);
    expect(body.finalizadoEm).not.toBeNull();
    expect(body.todosConformes).toBe(true);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("um item não conforme com observação -> 200, todosConformes=false (cenário misto)", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      resultado: index === 0 ? ("nao_conforme" as const) : ("conforme" as const),
      observacao: index === 0 ? "Guarda-corpo com folga — ajuste necessário." : undefined,
    }));

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().todosConformes).toBe(false);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("item obrigatório respondido como 'não aplicável' conta como resolvido -> todosConformes=true", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      resultado: index === 0 ? ("nao_aplicavel" as const) : ("conforme" as const),
    }));

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().todosConformes).toBe(true);
    await encerrarComoPendenteDeSobra(reservaId);
  });
});

describe("POST /reservas/:id/aprovar — checklist como portão da aprovação (RN-CHK-03)", () => {
  it("plataforma elevatória sem checklist finalizado -> aprovar retorna 409", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const resposta = await aprovar(reservaId);
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json().erro).toMatch(/checklist de segurança/i);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("checklist preenchido mas não finalizado (rascunho) -> aprovar ainda bloqueada", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const parcial = itensTemplateElevatoria.slice(0, 3).map((item) => ({ itemId: item.id, resultado: "conforme" as const }));
    await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: parcial },
    });

    const resposta = await aprovar(reservaId);
    expect(resposta.statusCode).toBe(409);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("checklist finalizado com não conformidade -> aprovar retorna 409", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    const respostas = itensTemplateElevatoria.map((item, index) => ({
      itemId: item.id,
      resultado: index === 0 ? ("nao_conforme" as const) : ("conforme" as const),
      observacao: index === 0 ? "Sistema de freio não trava — reprovado." : undefined,
    }));
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas },
    });

    const resposta = await aprovar(reservaId);
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json().erro).toMatch(/não conforme|RN-CHK-02|bloqueada/i);
    await encerrarComoPendenteDeSobra(reservaId);
  });

  it("checklist finalizado e conforme -> aprovar retorna 200, agendada", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasTodasConformes() },
    });

    const resposta = await aprovar(reservaId);
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().status).toBe("agendada");
  });
});

describe("PATCH /reservas/:id/status (iniciar_uso) — defesa redundante (RF-RES-10/RN-RES-12)", () => {
  it("reserva elevatória aprovada via fluxo completo (checklist ok) -> iniciar_uso 200", async () => {
    const reservaId = await criarReserva(plataformaElevatoriaId);
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: respostasTodasConformes() },
    });
    const aprovacao = await aprovar(reservaId);
    expect(aprovacao.statusCode).toBe(200);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("em_uso");
  });

  it("plataforma 'sala' (sem exigência) inicia uso normalmente sem checklist", async () => {
    const reservaId = await criarReserva(plataformaSalaId);
    const aprovacao = await aprovar(reservaId);
    expect(aprovacao.statusCode).toBe(200);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("em_uso");
  });
});
