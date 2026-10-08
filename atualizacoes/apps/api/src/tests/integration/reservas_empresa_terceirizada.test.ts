import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Nenhum e-mail sai daqui: a suíte não dispara notificação por si só, mas o app carrega rotas
// que importam a fila (BullMQ/Redis) — o dublê impede tanto a conexão quanto qualquer envio.
vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const { definirProviderEmailParaTeste } = await import("../../services/email.service.js");
const { criarProviderMockSempreAceita } = await import("../helpers/emailProviderMock.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  definirModoAprovacao,
  garantirSetor,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");
// A suíte verifica o status com que o colaborador cria: fixa o modo MANUAL (o banco de dev
// pode estar em automático, configurado pela tela) e restaura o valor original ao final.
let restaurarModo: (() => Promise<void>) | undefined;
const { MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA, MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA } = await import(
  "@plataformares/shared"
);

// Reserva do setor "Terceirizados" exige a empresa (regra por NOME do setor, sem flag no
// cadastro). A rota é a autoridade: setor interno ignora o campo e nunca persiste lixo.

const PREFIXO_EMAIL = "teste.agd.emp.";
const PREFIXOS = { plataforma: "PLT-AGD-EMP", email: PREFIXO_EMAIL, bloqueio: "AGD-EMP" };
const DATA = dataFuturaAleatoria();

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let setorTerceirizados: Setor;
let setorTi: Setor;
let plataformaId: string;
let terceirizado: Usuario;
let colaboradorTi: Usuario;
let admin: Usuario;

function payload(horaInicio: string, horaFim: string, extra: Record<string, unknown> = {}) {
  return {
    plataformaId,
    data: DATA,
    horaInicio,
    horaFim,
    quantidadePessoas: 1,
    motivo: "Serviço de teste (empresa terceirizada)",
    telefoneContato: "(11) 91234-5678",
    // Prioridade urgente: o teste não pode depender do expediente configurado no banco.
    prioridade: "urgente",
    ...extra,
  };
}

async function criar(usuario: Usuario, corpo: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/reservas", headers: { cookie: usuario.cookie }, payload: corpo });
}

async function contarReservas(): Promise<number> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .query<{ total: number }>("SELECT COUNT(*) AS total FROM Reserva WHERE plataforma_id = @plataforma_id");
  return r.recordset[0].total;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  definirProviderEmailParaTeste(criarProviderMockSempreAceita());
  restaurarModo = await definirModoAprovacao("manual");

  await limparResiduos(PREFIXOS);

  setorTerceirizados = await garantirSetor("Terceirizados");
  setorTi = await garantirSetor("TI");
  plataformaId = await criarPlataformaTeste({ codigo: "PLT-AGD-EMP-1", nome: "Plataforma teste empresa" });
  terceirizado = await criarUsuarioTeste({
    email: `${PREFIXO_EMAIL}terc@metalsider.com.br`,
    nome: "Colaborador Terceirizados (teste)",
    perfil: "colaborador",
    setorId: setorTerceirizados.id,
  });
  colaboradorTi = await criarUsuarioTeste({
    email: `${PREFIXO_EMAIL}ti@metalsider.com.br`,
    nome: "Colaborador TI (teste)",
    perfil: "colaborador",
    setorId: setorTi.id,
  });
  admin = await criarUsuarioTeste({
    email: `${PREFIXO_EMAIL}admin@metalsider.com.br`,
    nome: "Admin (teste empresa)",
    perfil: "admin",
    setorId: null,
  });
});

afterAll(async () => {
  definirProviderEmailParaTeste(null);
  await restaurarModo?.();
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setorTerceirizados);
  await removerSetorSeCriado(setorTi);
  await app.close();
  await closePool();
});

describe("POST /reservas — empresa terceirizada obrigatória no setor Terceirizados", () => {
  it("sem empresa → 422 no formato dos demais 422, com detalhes.fieldErrors.empresaTerceirizada", async () => {
    const response = await criar(terceirizado, payload("08:00", "09:00"));
    expect(response.statusCode).toBe(422);
    const corpo = response.json();
    expect(corpo.erro).toBe("Dados inválidos.");
    expect(corpo.detalhes.fieldErrors.empresaTerceirizada).toEqual([MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA]);
    expect(corpo.detalhes.formErrors).toEqual([]);
    expect(await contarReservas()).toBe(0);
  });

  it("empresa só com espaços → 422 e nada é gravado", async () => {
    const response = await criar(terceirizado, payload("08:00", "09:00", { empresaTerceirizada: "     " }));
    expect(response.statusCode).toBe(422);
    expect(response.json().detalhes.fieldErrors.empresaTerceirizada).toEqual([
      MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA,
    ]);
    expect(await contarReservas()).toBe(0);
  });

  it("empresa acima de 120 caracteres → 422 com a mensagem de tamanho", async () => {
    const response = await criar(terceirizado, payload("08:00", "09:00", { empresaTerceirizada: "x".repeat(121) }));
    expect(response.statusCode).toBe(422);
    expect(response.json().detalhes.fieldErrors.empresaTerceirizada).toEqual([MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA]);
  });

  it("o 422 de empresa não mascara o 404 de plataforma inexistente", async () => {
    const response = await criar(
      terceirizado,
      payload("08:00", "09:00", { plataformaId: "00000000-0000-4000-8000-000000000000" })
    );
    expect(response.statusCode).toBe(404);
  });

  it("com empresa → 201, valor normalizado no corpo e persistido na coluna", async () => {
    const response = await criar(
      terceirizado,
      payload("08:00", "09:00", { empresaTerceirizada: "  ACME   Montagens \t Ltda " })
    );
    expect(response.statusCode).toBe(201);
    const criada = response.json();
    // Colaborador solicita: a reserva nasce pendente de aprovação (migration 0022).
    expect(criada.status).toBe("pendente");
    expect(criada.setorNome).toBe("Terceirizados");
    expect(criada.empresaTerceirizada).toBe("ACME Montagens Ltda");

    const pool = await getPool();
    const linha = await pool
      .request()
      .input("id", sql.UniqueIdentifier, criada.id)
      .query<{ empresa_terceirizada: string | null }>("SELECT empresa_terceirizada FROM Reserva WHERE id = @id");
    expect(linha.recordset[0].empresa_terceirizada).toBe("ACME Montagens Ltda");
  });

  it("GET /reservas devolve a empresa da reserva", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas?data=${DATA}`,
      headers: { cookie: terceirizado.cookie },
    });
    expect(response.statusCode).toBe(200);
    const reservas = response.json() as Array<{ plataformaId: string; empresaTerceirizada: string | null }>;
    const minha = reservas.find((r) => r.plataformaId === plataformaId);
    expect(minha?.empresaTerceirizada).toBe("ACME Montagens Ltda");
  });

  it("a busca livre de GET /reservas encontra pelo nome da empresa", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reservas?q=${encodeURIComponent("Montagens")}&data=${DATA}`,
      headers: { cookie: terceirizado.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("a auditoria 'criar_reserva' leva a empresa nos detalhes", async () => {
    const pool = await getPool();
    const linhas = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .query<{ detalhes: string }>(
        `SELECT la.detalhes FROM LogAuditoria la
         JOIN Reserva r ON r.id = la.entidade_id
         WHERE la.acao = 'criar_reserva' AND la.entidade = 'Reserva' AND r.plataforma_id = @plataforma_id`
      );
    expect(linhas.recordset).toHaveLength(1);
    const detalhes = JSON.parse(linhas.recordset[0].detalhes);
    expect(detalhes.empresaTerceirizada).toBe("ACME Montagens Ltda");
    expect(detalhes.statusNovo).toBe("pendente");
  });

  it("GET /historico e a exportação CSV incluem a empresa", async () => {
    const historico = await app.inject({
      method: "GET",
      url: `/api/v1/historico?plataforma=${plataformaId}`,
      headers: { cookie: terceirizado.cookie },
    });
    expect(historico.statusCode).toBe(200);
    expect((historico.json() as Array<{ empresaTerceirizada: string | null }>)[0].empresaTerceirizada).toBe(
      "ACME Montagens Ltda"
    );

    const csv = await app.inject({
      method: "GET",
      url: `/api/v1/historico/export?plataforma=${plataformaId}`,
      headers: { cookie: terceirizado.cookie },
    });
    expect(csv.statusCode).toBe(200);
    const [cabecalho, primeiraLinha] = csv.body.replace(/^\uFEFF/, "").split("\r\n");
    const colunas = cabecalho.split(";");
    // Colunas anteriores preservadas, com a nova ao lado do setor.
    expect(colunas).toEqual([
      "ID",
      "Criada em",
      "Setor",
      "Empresa terceirizada",
      "Responsável",
      "Plataforma",
      "Data",
      "Início",
      // Reserva de vários dias (migration 0029): último dia do período.
      "Data final",
      "Fim",
      "Prioridade",
      "Status",
      "Motivo",
    ]);
    expect(primeiraLinha.split(";")[colunas.indexOf("Empresa terceirizada")]).toBe('"ACME Montagens Ltda"');
  });

  it("Admin solicitando para o setor Terceirizados também precisa informar a empresa", async () => {
    const sem = await criar(admin, payload("10:00", "11:00", { setorId: setorTerceirizados.id }));
    expect(sem.statusCode).toBe(422);
    expect(sem.json().detalhes.fieldErrors.empresaTerceirizada).toEqual([MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA]);

    const com = await criar(
      admin,
      payload("10:00", "11:00", { setorId: setorTerceirizados.id, empresaTerceirizada: "Beta Serviços" })
    );
    expect(com.statusCode).toBe(201);
    expect(com.json().empresaTerceirizada).toBe("Beta Serviços");
  });
});

describe("POST /reservas — setor interno nunca persiste empresa", () => {
  it("setor interno sem empresa → 201 com empresaTerceirizada null", async () => {
    const response = await criar(colaboradorTi, payload("12:00", "13:00"));
    expect(response.statusCode).toBe(201);
    expect(response.json().empresaTerceirizada).toBeNull();
  });

  it("setor interno COM empresa enviada → 201, ignora o valor e grava NULL", async () => {
    const response = await criar(colaboradorTi, payload("14:00", "15:00", { empresaTerceirizada: "Lixo Ltda" }));
    expect(response.statusCode).toBe(201);
    const criada = response.json();
    expect(criada.empresaTerceirizada).toBeNull();

    const pool = await getPool();
    const linha = await pool
      .request()
      .input("id", sql.UniqueIdentifier, criada.id)
      .query<{ empresa_terceirizada: string | null }>("SELECT empresa_terceirizada FROM Reserva WHERE id = @id");
    expect(linha.recordset[0].empresa_terceirizada).toBeNull();

    // ...e a auditoria também não carrega o valor descartado.
    const auditoria = await pool
      .request()
      .input("id", sql.UniqueIdentifier, criada.id)
      .query<{ detalhes: string }>(
        "SELECT detalhes FROM LogAuditoria WHERE entidade_id = @id AND acao = 'criar_reserva'"
      );
    expect(JSON.parse(auditoria.recordset[0].detalhes)).not.toHaveProperty("empresaTerceirizada");
  });

  it("empresa acima de 120 caracteres é 422 mesmo em setor interno (o campo não aceita lixo)", async () => {
    const response = await criar(colaboradorTi, payload("16:00", "17:00", { empresaTerceirizada: "y".repeat(121) }));
    expect(response.statusCode).toBe(422);
  });
});
