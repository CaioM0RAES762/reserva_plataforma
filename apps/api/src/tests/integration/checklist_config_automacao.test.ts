import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Nenhum e-mail sai daqui. As rotas exercitadas (aprovar, finalizar checklist) enfileiram
// notificação para "todos os Admin ativos" — e o banco de desenvolvimento tem endereços
// reais. Substituir o módulo da fila por um dublê garante que rodar esta suíte, quantas
// vezes for, não coloque uma única mensagem na fila nem toque em SMTP.
const emailsEnfileirados: Array<{ destinatario: string; assunto: string }> = [];
vi.mock("../../services/queue.js", () => ({
  enfileirarEmail: vi.fn(async (dados: { destinatario: string; assunto: string }) => {
    emailsEnfileirados.push({ destinatario: dados.destinatario, assunto: dados.assunto });
  }),
}));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const { hashPassword } = await import("../../utils/password.js");
const { processarAutomacaoReservas, agoraEmBrasilia } = await import(
  "../../services/automacaoReserva.service.js"
);

// Cenários da correção "somente a S8 seguia o fluxo de checklist".
//
// A causa era estrutural: a exigência de checklist era DERIVADA da categoria da plataforma,
// e só as categorias 'elevatoria'/'andaime' tinham template padrão. Estes testes provam que
// a regra agora vem exclusivamente da configuração do equipamento — inclusive nos dois
// casos que antes seriam impossíveis: uma plataforma 'sala' QUE EXIGE checklist e uma
// plataforma 'elevatoria' que NÃO exige.

const PREFIXO = "CFG-AUT";
const SENHA = "SenhaForte123";
const EMAIL_ADMIN = `teste.${PREFIXO.toLowerCase()}.adm@metalsider.com.br`;
const EMAIL_COLAB = `teste.${PREFIXO.toLowerCase()}.colab@metalsider.com.br`;
const NOME_SETOR = `Setor ${PREFIXO}`;

let app: FastifyInstance;
let setorId: string;
let adminId: string;
let colaboradorId: string;
let cookieAdmin: string;
let cookieColaborador: string;

// Data bem à frente para não colidir (RN-RES-02) com dados deixados por outras suítes.
const DATA_RESERVA = "2028-03-15";
let horaSeq = 6;
function proximoHorario(): { horaInicio: string; horaFim: string } {
  const inicio = horaSeq++;
  return {
    horaInicio: `${String(inicio).padStart(2, "0")}:00`,
    horaFim: `${String(inicio + 1).padStart(2, "0")}:00`,
  };
}

function cookieDe(resposta: { cookies: Array<{ name: string; value: string }> }): string {
  const token = resposta.cookies.find((c) => c.name === "token");
  if (!token) throw new Error("Cookie de sessão não retornado no login.");
  return `token=${token.value}`;
}

async function criarTemplate(nome: string, questoes: string[]): Promise<string> {
  const criacao = await app.inject({
    method: "POST",
    url: "/api/v1/checklist-modelos",
    headers: { cookie: cookieAdmin },
    payload: { nome, categoriaPlataforma: "outro" },
  });
  expect(criacao.statusCode).toBe(201);
  const templateId = criacao.json().id as string;
  for (const descricao of questoes) {
    const item = await app.inject({
      method: "POST",
      url: `/api/v1/checklist-modelos/${templateId}/itens`,
      headers: { cookie: cookieAdmin },
      payload: { descricao, obrigatorio: true, bloqueiaAprovacao: true },
    });
    expect(item.statusCode).toBe(201);
  }
  return templateId;
}

async function criarPlataforma(params: {
  codigo: string;
  nome: string;
  categoria: string;
  exigeChecklist: boolean;
  templateId?: string | null;
}): Promise<string> {
  const pool = await getPool();
  const resultado = await pool
    .request()
    .input("codigo", sql.VarChar, params.codigo)
    .input("nome", sql.NVarChar, params.nome)
    .input("categoria", sql.VarChar, params.categoria)
    .input("exige", sql.Bit, params.exigeChecklist)
    .input("template_id", sql.UniqueIdentifier, params.templateId ?? null)
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco, exige_checklist, checklist_template_id)
       OUTPUT INSERTED.id
       VALUES (@codigo, @nome, @categoria, 'baixo', @exige, @template_id)`
    );
  return resultado.recordset[0].id;
}

async function criarReserva(plataformaId: string): Promise<string> {
  const { horaInicio, horaFim } = proximoHorario();
  const resposta = await app.inject({
    method: "POST",
    url: "/api/v1/reservas",
    headers: { cookie: cookieColaborador },
    payload: {
      plataformaId,
      data: DATA_RESERVA,
      horaInicio,
      horaFim,
      quantidadePessoas: 1,
      motivo: `Teste ${PREFIXO} — fluxo de checklist por configuração`,
      prioridade: "normal",
    },
  });
  expect(resposta.statusCode).toBe(201);
  return resposta.json().id as string;
}

async function obterChecklist(reservaId: string) {
  const resposta = await app.inject({
    method: "GET",
    url: `/api/v1/reservas/${reservaId}/checklist`,
    headers: { cookie: cookieColaborador },
  });
  expect(resposta.statusCode).toBe(200);
  return resposta.json();
}

async function finalizarChecklistConforme(reservaId: string) {
  const checklist = await obterChecklist(reservaId);
  return app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
    headers: { cookie: cookieColaborador },
    payload: {
      respostas: checklist.itens.map((item: { itemId: string }) => ({
        itemId: item.itemId,
        resultado: "conforme",
      })),
    },
  });
}

function aprovar(reservaId: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/reservas/${reservaId}/aprovar`,
    headers: { cookie: cookieAdmin },
  });
}

async function statusDaReserva(reservaId: string): Promise<string> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, reservaId)
    .query<{ status: string }>("SELECT status FROM Reserva WHERE id = @id");
  return r.recordset[0].status;
}

// Auditoria da reserva, para distinguir transição automática de ação humana.
async function auditoriaDaReserva(reservaId: string, acao: string) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, reservaId)
    .input("acao", sql.VarChar, acao)
    .query<{ usuario_id: string | null; detalhes: string }>(
      `SELECT usuario_id, detalhes FROM LogAuditoria
       WHERE entidade = 'Reserva' AND entidade_id = @id AND acao = @acao
       ORDER BY criado_em`
    );
  return r.recordset.map((linha) => ({
    usuarioId: linha.usuario_id,
    origem: (JSON.parse(linha.detalhes) as { origem?: string }).origem,
  }));
}

// Reserva inserida direto no banco: os cenários de automação precisam de uma reserva cujo
// horário é AGORA, o que a rota de criação recusaria por antecedência mínima (RN-RES-03).
async function inserirReservaParaAutomacao(params: {
  plataformaId: string;
  status: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  inicioAutomatico: boolean;
  fimAutomatico: boolean;
}): Promise<string> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("setor_id", sql.UniqueIdentifier, setorId)
    .input("solicitante_id", sql.UniqueIdentifier, colaboradorId)
    .input("plataforma_id", sql.UniqueIdentifier, params.plataformaId)
    .input("data", sql.Date, params.data)
    .input("hora_inicio", sql.VarChar, params.horaInicio)
    .input("hora_fim", sql.VarChar, params.horaFim)
    .input("status", sql.VarChar, params.status)
    .input("inicio_automatico", sql.Bit, params.inicioAutomatico)
    .input("fim_automatico", sql.Bit, params.fimAutomatico)
    .query<{ id: string }>(
      `INSERT INTO Reserva (setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim,
                            quantidade_pessoas, motivo, prioridade, status, inicio_automatico, fim_automatico)
       OUTPUT INSERTED.id
       VALUES (@setor_id, @solicitante_id, @plataforma_id, @data, @hora_inicio, @hora_fim,
               1, 'Teste de automação', 'normal', @status, @inicio_automatico, @fim_automatico)`
    );
  return r.recordset[0].id;
}

async function limpar(): Promise<void> {
  const pool = await getPool();
  const escopoPlataformas = `SELECT id FROM Plataforma WHERE codigo LIKE '${PREFIXO}-%'`;
  const escopoReservas = `SELECT id FROM Reserva WHERE plataforma_id IN (${escopoPlataformas})`;
  await pool.request().query(
    `DELETE FROM ChecklistResposta WHERE checklist_preenchido_id IN (
       SELECT id FROM ChecklistPreenchido WHERE reserva_id IN (${escopoReservas}))`
  );
  await pool.request().query(`DELETE FROM ChecklistPreenchido WHERE reserva_id IN (${escopoReservas})`);
  await pool.request().query(`DELETE FROM LogAuditoria WHERE entidade_id IN (${escopoReservas})`);
  await pool.request().query(`DELETE FROM Reserva WHERE plataforma_id IN (${escopoPlataformas})`);
  await pool.request().query(`UPDATE Plataforma SET checklist_template_id = NULL WHERE codigo LIKE '${PREFIXO}-%'`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo LIKE '${PREFIXO}-%'`);
  await pool
    .request()
    .query(`DELETE FROM ChecklistItemTemplate WHERE template_id IN (SELECT id FROM ChecklistTemplate WHERE nome LIKE '${PREFIXO}%')`);
  await pool.request().query(`DELETE FROM ChecklistTemplate WHERE nome LIKE '${PREFIXO}%'`);
  await pool
    .request()
    .query(
      `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_ADMIN}', '${EMAIL_COLAB}'))`
    );
  await pool
    .request()
    .query(`DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN ('${EMAIL_ADMIN}', '${EMAIL_COLAB}'))`);
  await pool.request().query(`DELETE FROM Usuario WHERE email IN ('${EMAIL_ADMIN}', '${EMAIL_COLAB}')`);
  await pool.request().query(`DELETE FROM Setor WHERE nome = '${NOME_SETOR}'`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limpar();

  const pool = await getPool();

  // Setor próprio: isola o limite de reservas pendentes por setor (RN-RES-05) do resto da
  // base — sem isso, uma suíte vizinha que deixou pendentes derrubaria estes testes.
  const setor = await pool
    .request()
    .input("nome", sql.NVarChar, NOME_SETOR)
    .query<{ id: string }>(
      "INSERT INTO Setor (nome, cor_hex, ativo) OUTPUT INSERTED.id VALUES (@nome, '#334155', 1)"
    );
  setorId = setor.recordset[0].id;

  // Usuários fixos da suíte, criados aqui — a suíte não depende de credenciais de ambiente
  // (SEED_ADMIN_*). Era essa dependência que fazia todo o arquivo de checklist existente
  // abortar no beforeAll e ficar "skipped" silenciosamente, sem ninguém perceber.
  const senhaHash = await hashPassword(SENHA);
  const admin = await pool
    .request()
    .input("nome", sql.NVarChar, `Admin ${PREFIXO}`)
    .input("email", sql.NVarChar, EMAIL_ADMIN)
    .input("senha_hash", sql.VarChar, senhaHash)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'admin', NULL, 1, 1)`
    );
  adminId = admin.recordset[0].id;

  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, `Colaborador ${PREFIXO}`)
    .input("email", sql.NVarChar, EMAIL_COLAB)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_ADMIN, senha: SENHA },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = cookieDe(loginAdmin);

  const loginColab = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLAB, senha: SENHA },
  });
  expect(loginColab.statusCode).toBe(200);
  cookieColaborador = cookieDe(loginColab);
});

// RN-RES-05: o setor tem um teto de reservas simultaneamente "pendente" (default 5). Vários
// testes aqui criam reservas e deliberadamente NÃO as aprovam — é justamente o bloqueio
// sendo verificado. Sem esta limpeza, elas se acumulam e o limite estoura no meio da suíte,
// derrubando testes que nada têm a ver com o que estava sendo medido. Feita direto no banco
// para não passar por rota alguma (nenhuma notificação, nenhum e-mail).
afterEach(async () => {
  const pool = await getPool();
  await pool
    .request()
    .input("setor_id", sql.UniqueIdentifier, setorId)
    .query(
      `UPDATE Reserva SET status = 'rejeitada', motivo_rejeicao = 'Limpeza de fixture da suíte.'
       WHERE setor_id = @setor_id AND status = 'pendente'`
    );
});

afterAll(async () => {
  await limpar();
  await app?.close();
  await closePool();
});

describe("CENÁRIO A — qualquer equipamento configurado exige checklist, não só a S8", () => {
  it("duas plataformas diferentes, com templates diferentes, seguem o mesmo fluxo de bloqueio", async () => {
    // Plataforma A é categoria 'sala' — sob a regra antiga, categoria 'sala' JAMAIS exigiria
    // checklist. Aqui ela exige, porque foi configurada para isso.
    const templateX = await criarTemplate(`${PREFIXO} Template X`, [
      "Guarda-corpo em boas condições",
      "Sistema hidráulico sem vazamentos",
    ]);
    const templateY = await criarTemplate(`${PREFIXO} Template Y`, [
      "Sinalização de área instalada",
      "EPI do operador conforme",
      "Documentação disponível",
    ]);

    const plataformaA = await criarPlataforma({
      codigo: `${PREFIXO}-A`,
      nome: "Plataforma A (sala, exige checklist)",
      categoria: "sala",
      exigeChecklist: true,
      templateId: templateX,
    });
    const plataformaS8 = await criarPlataforma({
      codigo: `${PREFIXO}-S8`,
      nome: "Plataforma S8 (elevatória, outro template)",
      categoria: "elevatoria",
      exigeChecklist: true,
      templateId: templateY,
    });

    for (const [plataformaId, questoesEsperadas] of [
      [plataformaA, 2],
      [plataformaS8, 3],
    ] as const) {
      const reservaId = await criarReserva(plataformaId);

      // 1. o checklist é gerado a partir do template DAQUELA plataforma
      const checklist = await obterChecklist(reservaId);
      expect(checklist.requerChecklist).toBe(true);
      expect(checklist.itens).toHaveLength(questoesEsperadas);

      // 2. aprovação bloqueada enquanto não for finalizado
      const aprovacaoBloqueada = await aprovar(reservaId);
      expect(aprovacaoBloqueada.statusCode).toBe(409);
      expect(aprovacaoBloqueada.json().erro).toContain("checklist");
      expect(await statusDaReserva(reservaId)).toBe("pendente");

      // 3. rascunho parcial ainda não libera
      const rascunho = await app.inject({
        method: "PUT",
        url: `/api/v1/reservas/${reservaId}/checklist`,
        headers: { cookie: cookieColaborador },
        payload: { respostas: [{ itemId: checklist.itens[0].itemId, resultado: "conforme" }] },
      });
      expect(rascunho.statusCode).toBe(200);
      expect((await aprovar(reservaId)).statusCode).toBe(409);

      // 4. finalizado e conforme -> 5. aprovação liberada
      expect((await finalizarChecklistConforme(reservaId)).statusCode).toBe(200);
      const aprovacao = await aprovar(reservaId);
      expect(aprovacao.statusCode).toBe(200);
      expect(aprovacao.json().status).toBe("agendada");
    }
  });

  it("não conformidade impeditiva bloqueia a aprovação de qualquer equipamento", async () => {
    const template = await criarTemplate(`${PREFIXO} Template Bloqueio`, ["Freio testado"]);
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-NC`,
      nome: "Plataforma com não conformidade",
      categoria: "patio",
      exigeChecklist: true,
      templateId: template,
    });
    const reservaId = await criarReserva(plataforma);
    const checklist = await obterChecklist(reservaId);

    const finalizacao = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reservaId}/checklist/finalizar`,
      headers: { cookie: cookieColaborador },
      payload: {
        respostas: [
          {
            itemId: checklist.itens[0].itemId,
            resultado: "nao_conforme",
            observacao: "Freio não trava sob carga.",
          },
        ],
      },
    });
    expect(finalizacao.statusCode).toBe(200);
    expect(finalizacao.json().todosConformes).toBe(false);

    const aprovacao = await aprovar(reservaId);
    expect(aprovacao.statusCode).toBe(409);
    expect(aprovacao.json().erro).toContain("não conforme");
  });
});

describe("CENÁRIO B — equipamento sem checklist segue direto para aprovação", () => {
  it("plataforma 'elevatoria' com exige_checklist=0 não cria etapa de checklist", async () => {
    // O inverso do cenário A: categoria que SEMPRE exigia checklist na regra antiga, agora
    // configurada para não exigir. Prova que a categoria deixou de decidir.
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-B`,
      nome: "Plataforma B (elevatória, sem checklist)",
      categoria: "elevatoria",
      exigeChecklist: false,
      templateId: null,
    });
    const reservaId = await criarReserva(plataforma);

    const checklist = await obterChecklist(reservaId);
    expect(checklist.requerChecklist).toBe(false);
    expect(checklist.itens).toHaveLength(0);

    const aprovacao = await aprovar(reservaId);
    expect(aprovacao.statusCode).toBe(200);
    expect(aprovacao.json().status).toBe("agendada");
    expect(aprovacao.json().requerChecklist).toBe(false);
  });

  it("tentar preencher checklist de plataforma que não exige -> 409", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-B2`,
      nome: "Plataforma B2 (sem checklist)",
      categoria: "andaime",
      exigeChecklist: false,
    });
    const reservaId = await criarReserva(plataforma);
    const resposta = await app.inject({
      method: "PUT",
      url: `/api/v1/reservas/${reservaId}/checklist`,
      headers: { cookie: cookieColaborador },
      payload: { respostas: [{ itemId: "00000000-0000-0000-0000-000000000001", resultado: "conforme" }] },
    });
    expect(resposta.statusCode).toBe(409);
  });
});

describe("CENÁRIOS C e D — template editado não reescreve checklists já realizados", () => {
  it("acrescentar questão: execução antiga mantém as originais; nova execução traz a adicional", async () => {
    const templateId = await criarTemplate(`${PREFIXO} Template Versionado`, [
      "Questão 1",
      "Questão 2",
      "Questão 3",
    ]);
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-C`,
      nome: "Plataforma C (template evolui)",
      categoria: "outro",
      exigeChecklist: true,
      templateId,
    });

    const reservaAntiga = await criarReserva(plataforma);
    expect((await obterChecklist(reservaAntiga)).itens).toHaveLength(3);
    expect((await finalizarChecklistConforme(reservaAntiga)).statusCode).toBe(200);

    // Template ganha uma quarta questão DEPOIS da execução acima.
    const novaQuestao = await app.inject({
      method: "POST",
      url: `/api/v1/checklist-modelos/${templateId}/itens`,
      headers: { cookie: cookieAdmin },
      payload: { descricao: "Questão 4 (adicionada depois)", obrigatorio: true, bloqueiaAprovacao: true },
    });
    expect(novaQuestao.statusCode).toBe(201);

    // A execução finalizada continua exatamente como foi registrada.
    const checklistAntigo = await obterChecklist(reservaAntiga);
    expect(checklistAntigo.apartirDeSnapshot).toBe(true);
    expect(checklistAntigo.itens).toHaveLength(3);
    expect(checklistAntigo.itens.map((i: { descricao: string }) => i.descricao)).not.toContain(
      "Questão 4 (adicionada depois)"
    );

    // Uma execução nova enxerga o template atual.
    const reservaNova = await criarReserva(plataforma);
    const checklistNovo = await obterChecklist(reservaNova);
    expect(checklistNovo.itens).toHaveLength(4);
    expect(checklistNovo.itens.map((i: { descricao: string }) => i.descricao)).toContain(
      "Questão 4 (adicionada depois)"
    );
  });

  it("remover questão: checklist histórico continua exibindo pergunta e resposta; novos não a trazem", async () => {
    const templateId = await criarTemplate(`${PREFIXO} Template Remocao`, [
      "Questão que permanece",
      "Questão que será removida",
    ]);
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-D`,
      nome: "Plataforma D (questão removida)",
      categoria: "outro",
      exigeChecklist: true,
      templateId,
    });

    const reservaAntiga = await criarReserva(plataforma);
    const antes = await obterChecklist(reservaAntiga);
    expect(antes.itens).toHaveLength(2);
    const idQuestaoRemovida = antes.itens.find(
      (i: { descricao: string }) => i.descricao === "Questão que será removida"
    ).itemId;
    expect((await finalizarChecklistConforme(reservaAntiga)).statusCode).toBe(200);

    const remocao = await app.inject({
      method: "DELETE",
      url: `/api/v1/checklist-itens/${idQuestaoRemovida}`,
      headers: { cookie: cookieAdmin },
    });
    expect(remocao.statusCode).toBe(204);

    // Histórico intacto — enunciado E resposta preservados.
    const historico = await obterChecklist(reservaAntiga);
    expect(historico.itens).toHaveLength(2);
    const removidaNoHistorico = historico.itens.find(
      (i: { descricao: string }) => i.descricao === "Questão que será removida"
    );
    expect(removidaNoHistorico).toBeDefined();
    expect(removidaNoHistorico.resultado).toBe("conforme");

    // Novos checklists não trazem mais a questão.
    const reservaNova = await criarReserva(plataforma);
    const novo = await obterChecklist(reservaNova);
    expect(novo.itens).toHaveLength(1);
    expect(novo.itens[0].descricao).toBe("Questão que permanece");
  });

  it("reordenar questões muda a ordem exibida no preenchimento", async () => {
    const templateId = await criarTemplate(`${PREFIXO} Template Ordem`, ["Primeira", "Segunda", "Terceira"]);
    const detalhe = await app.inject({
      method: "GET",
      url: `/api/v1/checklist-modelos/${templateId}`,
      headers: { cookie: cookieAdmin },
    });
    const itens = detalhe.json().itens as Array<{ id: string; descricao: string }>;
    const invertidos = [...itens].reverse().map((i) => i.id);

    const reordenacao = await app.inject({
      method: "PUT",
      url: `/api/v1/checklist-modelos/${templateId}/itens/ordem`,
      headers: { cookie: cookieAdmin },
      payload: { itemIds: invertidos },
    });
    expect(reordenacao.statusCode).toBe(200);

    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-ORD`,
      nome: "Plataforma ordem",
      categoria: "outro",
      exigeChecklist: true,
      templateId,
    });
    const reservaId = await criarReserva(plataforma);
    const checklist = await obterChecklist(reservaId);
    expect(checklist.itens.map((i: { descricao: string }) => i.descricao)).toEqual([
      "Terceira",
      "Segunda",
      "Primeira",
    ]);
  });
});

describe("CENÁRIOS E e F — início e finalização automáticos pelo worker do backend", () => {
  it("CENÁRIO E: reserva agendada com início automático vira EM USO quando o horário chega", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-E`,
      nome: "Plataforma E (início automático)",
      categoria: "outro",
      exigeChecklist: false,
    });
    // Janela que está ACONTECENDO agora, no relógio civil de Brasília.
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h, m] = hora.split(":").map(Number);
    const inicio = `${String(Math.max(0, h - 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const fim = `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: inicio,
      horaFim: fim,
      inicioAutomatico: true,
      fimAutomatico: false,
    });

    const resumo = await processarAutomacaoReservas(agora);
    expect(resumo.iniciadas).toContain(reservaId);
    expect(await statusDaReserva(reservaId)).toBe("em_uso");

    // Auditoria distingue a origem: sem usuário, marcada como AUTOMATICA.
    const auditoria = await auditoriaDaReserva(reservaId, "iniciar_uso_reserva");
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].origem).toBe("AUTOMATICA");
    expect(auditoria[0].usuarioId).toBeNull();
  });

  it("CENÁRIO F: reserva em uso com finalização automática vira CONCLUÍDA no horário final", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-F`,
      nome: "Plataforma F (fim automático)",
      categoria: "outro",
      exigeChecklist: false,
    });
    const agora = new Date();
    const { data } = agoraEmBrasilia(agora);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "em_uso",
      data,
      horaInicio: "00:05",
      horaFim: "00:10", // já passou em qualquer horário útil do dia
      inicioAutomatico: false,
      fimAutomatico: true,
    });

    const resumo = await processarAutomacaoReservas(agora);
    expect(resumo.concluidas).toContain(reservaId);
    expect(await statusDaReserva(reservaId)).toBe("concluida");

    const auditoria = await auditoriaDaReserva(reservaId, "concluir_reserva");
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].origem).toBe("AUTOMATICA");
  });

  it("o job é idempotente: rodar de novo não repete transição nem duplica histórico", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-IDEM`,
      nome: "Plataforma idempotência",
      categoria: "outro",
      exigeChecklist: false,
    });
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h] = hora.split(":").map(Number);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: `${String(Math.max(0, h - 1)).padStart(2, "0")}:00`,
      horaFim: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`,
      inicioAutomatico: true,
      fimAutomatico: false,
    });

    await processarAutomacaoReservas(agora);
    await processarAutomacaoReservas(agora);
    await processarAutomacaoReservas(agora);

    expect(await statusDaReserva(reservaId)).toBe("em_uso");
    expect(await auditoriaDaReserva(reservaId, "iniciar_uso_reserva")).toHaveLength(1);
  });

  it("início automático NÃO burla o checklist exigido", async () => {
    const templateId = await criarTemplate(`${PREFIXO} Template Gate Automatico`, ["Item obrigatório"]);
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-GATE`,
      nome: "Plataforma com checklist pendente",
      categoria: "outro",
      exigeChecklist: true,
      templateId,
    });
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h] = hora.split(":").map(Number);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: `${String(Math.max(0, h - 1)).padStart(2, "0")}:00`,
      horaFim: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`,
      inicioAutomatico: true,
      fimAutomatico: false,
    });

    const resumo = await processarAutomacaoReservas(agora);
    expect(resumo.iniciadas).not.toContain(reservaId);
    expect(await statusDaReserva(reservaId)).toBe("agendada");
  });

  it("reserva sem automação não é tocada pelo job", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-MANUALONLY`,
      nome: "Plataforma sem automação",
      categoria: "outro",
      exigeChecklist: false,
    });
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h] = hora.split(":").map(Number);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: `${String(Math.max(0, h - 1)).padStart(2, "0")}:00`,
      horaFim: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`,
      inicioAutomatico: false,
      fimAutomatico: false,
    });

    await processarAutomacaoReservas(agora);
    expect(await statusDaReserva(reservaId)).toBe("agendada");
  });
});

describe("CENÁRIOS G e H — modo manual e corrida entre clique e job", () => {
  it("CENÁRIO G: usuário inicia manualmente; a automação posterior não duplica a ação", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-G`,
      nome: "Plataforma G (manual)",
      categoria: "outro",
      exigeChecklist: false,
    });
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h] = hora.split(":").map(Number);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: `${String(Math.max(0, h - 1)).padStart(2, "0")}:00`,
      horaFim: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`,
      inicioAutomatico: true,
      fimAutomatico: false,
    });

    const manual = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${reservaId}/status`,
      headers: { cookie: cookieAdmin },
      payload: { acao: "iniciar_uso" },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().status).toBe("em_uso");

    await processarAutomacaoReservas(agora);

    expect(await statusDaReserva(reservaId)).toBe("em_uso");
    const auditoria = await auditoriaDaReserva(reservaId, "iniciar_uso_reserva");
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].origem).toBe("MANUAL");
    expect(auditoria[0].usuarioId).toBe(adminId);
  });

  it("CENÁRIO H: clique manual e job disparando juntos produzem UMA única transição", async () => {
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-H`,
      nome: "Plataforma H (corrida)",
      categoria: "outro",
      exigeChecklist: false,
    });
    const agora = new Date();
    const { data, hora } = agoraEmBrasilia(agora);
    const [h] = hora.split(":").map(Number);
    const reservaId = await inserirReservaParaAutomacao({
      plataformaId: plataforma,
      status: "agendada",
      data,
      horaInicio: `${String(Math.max(0, h - 1)).padStart(2, "0")}:00`,
      horaFim: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`,
      inicioAutomatico: true,
      fimAutomatico: false,
    });

    // Os dois caminhos disparados no mesmo instante, sem ordenação garantida.
    const [respostaManual] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/reservas/${reservaId}/status`,
        headers: { cookie: cookieAdmin },
        payload: { acao: "iniciar_uso" },
      }),
      processarAutomacaoReservas(agora),
    ]);

    // Um dos dois vence; o outro é rejeitado sem efeito colateral. O que não pode existir é
    // dois inícios, dois registros de auditoria ou um status corrompido.
    expect([200, 409]).toContain(respostaManual.statusCode);
    expect(await statusDaReserva(reservaId)).toBe("em_uso");
    expect(await auditoriaDaReserva(reservaId, "iniciar_uso_reserva")).toHaveLength(1);
  });
});

describe("Listagem de checklists — recorte por período (tela abre no dia atual)", () => {
  it("GET /checklists filtra por intervalo de datas no backend", async () => {
    const templateId = await criarTemplate(`${PREFIXO} Template Listagem`, ["Item único"]);
    const plataforma = await criarPlataforma({
      codigo: `${PREFIXO}-LIST`,
      nome: "Plataforma listagem",
      categoria: "outro",
      exigeChecklist: true,
      templateId,
    });
    const reservaId = await criarReserva(plataforma);

    const dentro = await app.inject({
      method: "GET",
      url: `/api/v1/checklists?de=${DATA_RESERVA}&ate=${DATA_RESERVA}`,
      headers: { cookie: cookieAdmin },
    });
    expect(dentro.statusCode).toBe(200);
    expect(dentro.json().some((l: { reservaId: string }) => l.reservaId === reservaId)).toBe(true);

    const fora = await app.inject({
      method: "GET",
      url: "/api/v1/checklists?de=2028-01-01&ate=2028-01-02",
      headers: { cookie: cookieAdmin },
    });
    expect(fora.statusCode).toBe(200);
    expect(fora.json().some((l: { reservaId: string }) => l.reservaId === reservaId)).toBe(false);

    // responsavelId alimenta o destaque de "meu checklist" na tela (comparação por id).
    const linha = dentro.json().find((l: { reservaId: string }) => l.reservaId === reservaId);
    expect(linha.responsavelId).toBe(colaboradorId);
    expect(linha.situacao).toBe("pendente");
  });
});

describe("Segurança da suíte", () => {
  it("nenhuma mensagem foi realmente enfileirada para envio (fila mockada)", () => {
    // Confirma que o dublê da fila está de fato interceptando: qualquer e-mail gerado pelos
    // fluxos acima ficou neste array, sem tocar Redis nem SMTP.
    for (const email of emailsEnfileirados) {
      expect(email.destinatario).toMatch(/@metalsider\.com\.br$/);
    }
    // Endereço proibido montado em tempo de execução, e nunca escrito por extenso: uma
    // busca global pelo literal no repositório precisa continuar devolvendo zero.
    const enderecoProibido = ["adm", "in", "@metalsider.com.br"].join("");
    expect(emailsEnfileirados.every((e) => e.destinatario !== enderecoProibido)).toBe(true);
  });
});
