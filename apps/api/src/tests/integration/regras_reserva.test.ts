import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const { definirProviderEmailParaTeste } = await import("../../services/email.service.js");
const { criarProviderMockSempreAceita } = await import("../helpers/emailProviderMock.js");
const { invalidarCacheConfiguracao, obterRegrasReservaConfiguraveis } = await import(
  "../../services/configuracao.service.js"
);
const { registrarClienteSSE, removerClienteSSE } = await import("../../services/eventos.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

// GET /configuracoes/regras-reserva (qualquer perfil) e as validações/efeitos do PUT
// /configuracoes sobre o expediente. Esta suíte ALTERA o expediente do banco de dev durante a
// execução — os valores originais são restaurados no afterAll (inclusive atualizado_em/por_id).

const PREFIXOS = { plataforma: "PLT-AGD-REG", email: "teste.agd.reg.", bloqueio: "AGD-REG" };
const CHAVES = ["horario_expediente_inicio", "horario_expediente_fim"] as const;

interface ConfigOriginal {
  chave: string;
  valor: string;
  atualizado_em: Date;
  atualizado_por_id: string | null;
}

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let setorTi: Setor;
let colaborador: Usuario;
let admin: Usuario;
let plataformaId: string;
let originais: ConfigOriginal[] = [];

async function regras(usuario: Usuario) {
  return app.inject({
    method: "GET",
    url: "/api/v1/configuracoes/regras-reserva",
    headers: { cookie: usuario.cookie },
  });
}

async function atualizar(payload: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/configuracoes",
    headers: { cookie: admin.cookie },
    payload,
  });
}

async function valorGravado(chave: (typeof CHAVES)[number]): Promise<string> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("chave", sql.VarChar, chave)
    .query<{ valor: string }>("SELECT valor FROM ConfiguracaoSistema WHERE chave = @chave");
  return r.recordset[0].valor;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  definirProviderEmailParaTeste(criarProviderMockSempreAceita());

  await limparResiduos(PREFIXOS);

  // Snapshot ANTES de qualquer PUT: é o que o afterAll devolve ao banco.
  const pool = await getPool();
  // TODAS as chaves, não só o expediente: um PUT que toque outra chave também troca
  // atualizado_por_id para o admin de teste, e essa FK impediria apagá-lo no afterAll.
  const linhas = await pool
    .request()
    .query<ConfigOriginal>("SELECT chave, valor, atualizado_em, atualizado_por_id FROM ConfiguracaoSistema");
  originais = linhas.recordset;
  expect(originais.length).toBeGreaterThanOrEqual(2);

  setorTi = await garantirSetor("TI");
  colaborador = await criarUsuarioTeste({
    email: `${PREFIXOS.email}colab@metalsider.com.br`,
    nome: "Colaborador (teste regras)",
    perfil: "colaborador",
    setorId: setorTi.id,
  });
  admin = await criarUsuarioTeste({
    email: `${PREFIXOS.email}admin@metalsider.com.br`,
    nome: "Admin (teste regras)",
    perfil: "admin",
    setorId: null,
  });
  plataformaId = await criarPlataformaTeste({ codigo: "PLT-AGD-REG-1", nome: "Plataforma teste regras" });
});

afterAll(async () => {
  definirProviderEmailParaTeste(null);
  try {
    // Restaura os valores E os metadados: quem olhar a tela de configurações não deve ver
    // "atualizado por um usuário de teste" nem uma data de hoje.
    const pool = await getPool();
    for (const original of originais) {
      await pool
        .request()
        .input("chave", sql.VarChar, original.chave)
        .input("valor", sql.NVarChar, original.valor)
        .input("atualizado_em", sql.DateTime2, original.atualizado_em)
        .input("atualizado_por_id", sql.UniqueIdentifier, original.atualizado_por_id)
        .query(
          `UPDATE ConfiguracaoSistema SET valor = @valor, atualizado_em = @atualizado_em,
                  atualizado_por_id = @atualizado_por_id WHERE chave = @chave`
        );
    }
    invalidarCacheConfiguracao();
  } finally {
    await limparResiduos(PREFIXOS);
    await removerSetorSeCriado(setorTi);
    await app.close();
    await closePool();
  }
});

describe("GET /configuracoes/regras-reserva", () => {
  it("sem sessão → 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/configuracoes/regras-reserva" });
    expect(response.statusCode).toBe(401);
  });

  it("colaborador (que não lê GET /configuracoes) lê as regras públicas, com Cache-Control: no-store", async () => {
    const restrita = await app.inject({
      method: "GET",
      url: "/api/v1/configuracoes",
      headers: { cookie: colaborador.cookie },
    });
    expect(restrita.statusCode).toBe(403);

    const response = await regras(colaborador);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");

    const corpo = response.json();
    expect(Object.keys(corpo).sort()).toEqual([
      "antecedenciaMinimaHoras",
      "duracaoMaximaHoras",
      "horarioExpedienteFim",
      "horarioExpedienteInicio",
    ]);
    // Mesma fonte que a validação de POST /reservas.
    const validacao = await obterRegrasReservaConfiguraveis();
    expect(corpo).toEqual({
      horarioExpedienteInicio: validacao.horarioExpedienteInicio,
      horarioExpedienteFim: validacao.horarioExpedienteFim,
      duracaoMaximaHoras: validacao.duracaoMaximaHoras,
      antecedenciaMinimaHoras: validacao.antecedenciaMinimaHoras,
    });
    expect(corpo.horarioExpedienteInicio).toMatch(/^\d{2}:\d{2}$/);
  });

  it("admin também lê", async () => {
    expect((await regras(admin)).statusCode).toBe(200);
  });
});

describe("PUT /configuracoes — expediente", () => {
  it("Admin muda o expediente e a leitura seguinte reflete SEM reiniciar (cache invalidado)", async () => {
    // Estado de partida conhecido (o do banco de dev pode ser qualquer um) e cache aquecido com ele.
    expect((await atualizar({ horarioExpedienteInicio: "05:00", horarioExpedienteFim: "20:00" })).statusCode).toBe(200);
    const antes = (await regras(colaborador)).json();
    expect(antes).toMatchObject({ horarioExpedienteInicio: "05:00", horarioExpedienteFim: "20:00" });

    const put = await atualizar({ horarioExpedienteInicio: "00:00", horarioExpedienteFim: "23:59" });
    expect(put.statusCode).toBe(200);

    const depois = await regras(colaborador);
    expect(depois.json().horarioExpedienteInicio).toBe("00:00");
    expect(depois.json().horarioExpedienteFim).toBe("23:59");
    expect(depois.json()).not.toEqual(antes);
  });

  it("00:00 e 23:59 são valores válidos e a mesma regra vale na validação de POST /reservas", async () => {
    // Expediente 00:00–23:59 (dia inteiro): uma reserva às 03:00 NÃO exige prioridade urgente.
    const data = dataFuturaAleatoria();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: colaborador.cookie },
      payload: {
        plataformaId,
        data,
        horaInicio: "03:00",
        horaFim: "04:00",
        quantidadePessoas: 1,
        motivo: "Reserva de madrugada (teste do expediente)",
        telefoneContato: "(11) 91234-5678",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("estreitar o expediente na leitura seguinte passa a recusar o mesmo horário (sem reiniciar)", async () => {
    const put = await atualizar({ horarioExpedienteInicio: "08:00", horarioExpedienteFim: "18:00" });
    expect(put.statusCode).toBe(200);
    expect((await regras(colaborador)).json()).toMatchObject({
      horarioExpedienteInicio: "08:00",
      horarioExpedienteFim: "18:00",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: colaborador.cookie },
      payload: {
        plataformaId,
        data: dataFuturaAleatoria(),
        horaInicio: "03:00",
        horaFim: "04:00",
        quantidadePessoas: 1,
        motivo: "Reserva de madrugada (fora do expediente)",
        telefoneContato: "(11) 91234-5678",
        prioridade: "normal",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toMatch(/expediente/i);
  });

  it("fim <= início (os dois no corpo) → 422 e nada muda", async () => {
    const response = await atualizar({ horarioExpedienteInicio: "10:00", horarioExpedienteFim: "10:00" });
    expect(response.statusCode).toBe(422);
    expect(response.json().detalhes.fieldErrors.horarioExpedienteFim).toBeDefined();
    expect(await valorGravado("horario_expediente_inicio")).toBe("08:00");
    expect(await valorGravado("horario_expediente_fim")).toBe("18:00");
  });

  it("só o fim no corpo, e ele não é depois do início JÁ GRAVADO → 422 claro", async () => {
    // início gravado = 08:00
    const response = await atualizar({ horarioExpedienteFim: "08:00" });
    expect(response.statusCode).toBe(422);
    const corpo = response.json();
    expect(corpo.erro).toBe("Dados inválidos.");
    expect(corpo.detalhes.fieldErrors.horarioExpedienteFim[0]).toContain("08:00");
    expect(await valorGravado("horario_expediente_fim")).toBe("18:00");

    const antes = await atualizar({ horarioExpedienteFim: "07:59" });
    expect(antes.statusCode).toBe(422);
  });

  it("só o início no corpo, e ele não é antes do fim JÁ GRAVADO → 422 claro", async () => {
    // fim gravado = 18:00
    const response = await atualizar({ horarioExpedienteInicio: "18:00" });
    expect(response.statusCode).toBe(422);
    expect(response.json().detalhes.fieldErrors.horarioExpedienteInicio[0]).toContain("18:00");
    expect(await valorGravado("horario_expediente_inicio")).toBe("08:00");

    expect((await atualizar({ horarioExpedienteInicio: "23:59" })).statusCode).toBe(422);
  });

  it("um dos horários sozinho, coerente com o gravado, é aceito (incluindo os extremos 00:00 e 23:59)", async () => {
    const inicio = await atualizar({ horarioExpedienteInicio: "00:00" });
    expect(inicio.statusCode).toBe(200);
    expect(await valorGravado("horario_expediente_inicio")).toBe("00:00");

    const fim = await atualizar({ horarioExpedienteFim: "23:59" });
    expect(fim.statusCode).toBe(200);
    expect(await valorGravado("horario_expediente_fim")).toBe("23:59");
  });

  it("PUT que não mexe no expediente não dispara a checagem (outros campos seguem livres)", async () => {
    const original = (await regras(colaborador)).json().antecedenciaMinimaHoras as number;
    const response = await atualizar({ antecedenciaMinimaHoras: original });
    expect(response.statusCode).toBe(200);
  });

  it("colaborador não pode alterar configurações (403)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: colaborador.cookie },
      payload: { horarioExpedienteInicio: "05:00" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("publica 'configuracao.atualizada' para os clientes SSE conectados (e só depois do commit)", async () => {
    const escritas: string[] = [];
    const respostaFalsa = {
      raw: {
        writableEnded: false,
        destroyed: false,
        write: (texto: string) => {
          escritas.push(texto);
          return true;
        },
      },
    };
    const clienteId = registrarClienteSSE(colaborador.id, respostaFalsa as never);
    try {
      const invalido = await atualizar({ horarioExpedienteFim: "00:00" });
      expect(invalido.statusCode).toBe(422);
      expect(escritas.filter((t) => t.includes("configuracao.atualizada"))).toHaveLength(0);

      const valido = await atualizar({ horarioExpedienteInicio: "07:00", horarioExpedienteFim: "19:00" });
      expect(valido.statusCode).toBe(200);
      const eventos = escritas.filter((t) => t.startsWith("event: configuracao.atualizada"));
      expect(eventos).toHaveLength(1);
      expect(eventos[0]).toContain("horario_expediente_inicio");
      // Quando o evento chega, a releitura das regras já vê o valor novo.
      expect((await regras(colaborador)).json()).toMatchObject({
        horarioExpedienteInicio: "07:00",
        horarioExpedienteFim: "19:00",
      });
    } finally {
      removerClienteSSE(clienteId);
    }
  });

  it("a auditoria 'atualizar_configuracao' registra a alteração feita pelo Admin", async () => {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, admin.id)
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM LogAuditoria WHERE acao = 'atualizar_configuracao' AND usuario_id = @usuario_id"
      );
    expect(r.recordset[0].total).toBeGreaterThanOrEqual(1);
  });
});
