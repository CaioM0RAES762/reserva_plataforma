import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// Cobertura de regressão para os defeitos corrigidos no refinamento geral pós-S14.
// Cada bloco abaixo falharia no código anterior — nenhum deles tinha teste algum, que é
// exatamente o motivo de terem passado despercebidos por 14 sprints.

const EMAIL_ADMIN = process.env.SEED_ADMIN_EMAIL ?? "caio.moraes@metalsider.com.br";
const SENHA_ADMIN = process.env.SEED_ADMIN_PASSWORD ?? "AdminForte123";
const EMAIL_COLAB = "colaborador.refinamento@metalsider.com.br";
const SENHA_COLAB = "SenhaForte123";

let app: FastifyInstance;
let cookieAdmin: string;
let cookieColaborador: string;
let plataformaId: string;
let setorId: string;
let colaboradorId: string;

async function login(email: string, senha: string): Promise<string> {
  const resposta = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, senha } });
  const setCookie = resposta.headers["set-cookie"];
  const bruto = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return bruto.split(";")[0];
}

// Datas bem à frente e com deslocamento aleatório, mesmo padrão do ADR-04 de S14: evita
// colisão (RN-RES-02) com registros deixados por execuções anteriores da suíte.
const DIAS_BASE = 400 + Math.floor(Math.random() * 300);
function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  app = await buildApp();
  const pool = await getPool();

  const setor = await pool
    .request()
    .query<{ id: string }>("SELECT TOP 1 id FROM Setor WHERE nome = 'TI' AND ativo = 1");
  setorId = setor.recordset[0].id;

  await pool
    .request()
    .input("email", sql.NVarChar, EMAIL_COLAB)
    .query("DELETE FROM Usuario WHERE email = @email");
  const criado = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Refinamento")
    .input("email", sql.NVarChar, EMAIL_COLAB)
    .input("senha_hash", sql.VarChar, await hashPassword(SENHA_COLAB))
    .input("setor_id", sql.UniqueIdentifier, setorId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = criado.recordset[0].id;

  const plataforma = await pool
    .request()
    .query<{ id: string }>(
      "SELECT TOP 1 id FROM Plataforma WHERE status = 'disponivel' AND categoria NOT IN ('elevatoria','andaime') ORDER BY codigo"
    );
  plataformaId = plataforma.recordset[0].id;

  cookieAdmin = await login(EMAIL_ADMIN, SENHA_ADMIN);
  cookieColaborador = await login(EMAIL_COLAB, SENHA_COLAB);
});

afterAll(async () => {
  const pool = await getPool();
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
    .query("DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Reserva WHERE solicitante_id = @usuario_id)");
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
    .query("DELETE FROM Notificacao WHERE usuario_id = @usuario_id");
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
    .query("DELETE FROM Reserva WHERE solicitante_id = @usuario_id");
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
    .query("DELETE FROM LogAuditoria WHERE usuario_id = @usuario_id");
  await pool
    .request()
    .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
    .query("DELETE FROM Usuario WHERE id = @usuario_id");
  await app.close();
});

describe("Criação concorrente de reserva (RN-RES-02 sob concorrência)", () => {
  it("duas requisições simultâneas para o MESMO horário criam apenas uma reserva", async () => {
    const data = dataDaqui(DIAS_BASE);
    const payload = {
      plataformaId,
      data,
      horaInicio: "08:00",
      horaFim: "09:00",
      quantidadePessoas: 1,
      motivo: "Teste de corrida na checagem de conflito (RN-RES-02)",
      prioridade: "normal" as const,
    };

    // A checagem de disponibilidade rodava ANTES de transaction.begin(): ambas as
    // requisições liam "livre" e ambas inseriam. Com o lock de intervalo dentro da
    // transação, a segunda espera a primeira e recebe 409.
    const [primeira, segunda] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/reservas",
        headers: { cookie: cookieColaborador },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/reservas",
        headers: { cookie: cookieColaborador },
        payload,
      }),
    ]);

    const statuses = [primeira.statusCode, segunda.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const pool = await getPool();
    const persistidas = await pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .input("data", sql.Date, data)
      .query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM Reserva
         WHERE plataforma_id = @plataforma_id AND data = @data AND status IN ('pendente','agendada','em_uso')`
      );
    expect(persistidas.recordset[0].total).toBe(1);
  });

  it("POST /reservas devolve a reserva realmente criada (recarga por id, não heurística)", async () => {
    const data = dataDaqui(DIAS_BASE + 1);
    const resposta = await app.inject({
      method: "POST",
      url: "/api/v1/reservas",
      headers: { cookie: cookieColaborador },
      payload: {
        plataformaId,
        data,
        horaInicio: "10:00",
        horaFim: "11:00",
        quantidadePessoas: 1,
        motivo: "Teste de recarga por id do registro inserido",
        prioridade: "normal",
      },
    });
    expect(resposta.statusCode).toBe(201);
    const corpo = resposta.json();
    expect(corpo.data).toBe(data);
    expect(corpo.horaInicio).toBe("10:00");
    expect(corpo.status).toBe("pendente");

    const pool = await getPool();
    const conferencia = await pool
      .request()
      .input("id", sql.UniqueIdentifier, corpo.id)
      .query<{ total: number }>("SELECT COUNT(*) AS total FROM Reserva WHERE id = @id");
    expect(conferencia.recordset[0].total).toBe(1);
  });
});

describe("Paginação das listagens", () => {
  it("GET /reservas respeita limit/offset e informa o total real no header", async () => {
    const primeira = await app.inject({
      method: "GET",
      url: "/api/v1/reservas?limit=1&offset=0",
      headers: { cookie: cookieAdmin },
    });
    expect(primeira.statusCode).toBe(200);
    expect(primeira.json()).toHaveLength(1);

    const total = Number(primeira.headers["x-total-count"]);
    // O total do header é o do filtro inteiro, não o da página devolvida.
    expect(total).toBeGreaterThanOrEqual(2);

    const segunda = await app.inject({
      method: "GET",
      url: "/api/v1/reservas?limit=1&offset=1",
      headers: { cookie: cookieAdmin },
    });
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json()[0].id).not.toBe(primeira.json()[0].id);
    expect(Number(segunda.headers["x-total-count"])).toBe(total);
  });

  it("GET /historico expõe X-Total-Count junto com a janela paginada", async () => {
    const resposta = await app.inject({
      method: "GET",
      url: "/api/v1/historico?limit=2&offset=0",
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().length).toBeLessThanOrEqual(2);
    expect(Number(resposta.headers["x-total-count"])).toBeGreaterThanOrEqual(resposta.json().length);
  });

  it("GET /auditoria pagina e não trunca mais silenciosamente em 500", async () => {
    const resposta = await app.inject({
      method: "GET",
      url: "/api/v1/auditoria?limit=5&offset=0",
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().length).toBeLessThanOrEqual(5);
    expect(resposta.headers["x-total-count"]).toBeDefined();
  });
});

describe("Validação de query em GET /reservas", () => {
  it("rejeita status fora do enum com 422 em vez de devolver lista vazia sem explicação", async () => {
    const resposta = await app.inject({
      method: "GET",
      url: "/api/v1/reservas?status=inexistente",
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(422);
    expect(resposta.json().erro).toContain("inválidos");
  });

  it("rejeita data em formato inválido em vez de estourar 500 no driver", async () => {
    const resposta = await app.inject({
      method: "GET",
      url: "/api/v1/reservas?data=31-12-2026",
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(422);
  });

  it("aceita busca livre pelo motivo da reserva (antes só setor/responsável/plataforma)", async () => {
    const resposta = await app.inject({
      method: "GET",
      url: "/api/v1/reservas?q=recarga%20por%20id",
      headers: { cookie: cookieAdmin },
    });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().length).toBeGreaterThan(0);
  });
});

describe("Envelope de erro e rotas inexistentes", () => {
  it("rota inexistente responde 404 no formato { erro } do restante da API", async () => {
    const resposta = await app.inject({ method: "GET", url: "/api/v1/rota-que-nao-existe" });
    expect(resposta.statusCode).toBe(404);
    expect(resposta.json()).toHaveProperty("erro");
  });

  it("erro de autenticação também usa { erro }", async () => {
    const resposta = await app.inject({ method: "GET", url: "/api/v1/reservas" });
    expect(resposta.statusCode).toBe(401);
    expect(resposta.json()).toHaveProperty("erro");
  });
});

describe("Logout limpa o cookie com os mesmos atributos de escopo", () => {
  it("Set-Cookie do logout repete path/httpOnly/sameSite usados na criação", async () => {
    const resposta = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(resposta.statusCode).toBe(200);
    const setCookie = resposta.headers["set-cookie"];
    const bruto = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie);
    // Sem estes atributos, o navegador trata como um cookie diferente e não remove o
    // cookie de sessão original — a sessão continuava válida após "Sair".
    expect(bruto).toContain("Path=/");
    expect(bruto).toContain("HttpOnly");
    expect(bruto).toContain("SameSite=Strict");
  });
});

describe("Auditoria — leitura de detalhes", () => {
  // Observação importante: a constraint CK_LogAuditoria_detalhes_json (migration 0001)
  // impede que texto não-JSON chegue à coluna — confirmado tentando inserir "texto solto"
  // e recebendo a violação da constraint. A tolerância adicionada em interpretarDetalhes
  // é, portanto, defesa em profundidade (proteção caso a constraint seja removida ou os
  // dados venham de uma importação), não a correção de uma falha explorável hoje.
  // O que este teste garante é o comportamento observável da rota.
  it("a coluna é protegida por constraint: JSON inválido nem chega a ser gravado", async () => {
    const pool = await getPool();
    await expect(
      pool
        .request()
        .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
        .input("detalhes", sql.NVarChar, "texto solto, não é JSON")
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'teste_refinamento', 'Reserva', NULL, @detalhes)`
        )
    ).rejects.toThrow(/CK_LogAuditoria_detalhes_json/);
  });

  it("detalhes em JSON válido são devolvidos já desserializados", async () => {
    const pool = await getPool();
    const inserido = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, colaboradorId)
      .input("detalhes", sql.NVarChar, JSON.stringify({ statusAnterior: "pendente", statusNovo: "agendada" }))
      .query<{ id: string }>(
        `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
         OUTPUT INSERTED.id
         VALUES (@usuario_id, 'teste_refinamento', 'Reserva', NULL, @detalhes)`
      );

    try {
      const resposta = await app.inject({
        method: "GET",
        url: "/api/v1/auditoria?acao=teste_refinamento",
        headers: { cookie: cookieAdmin },
      });
      expect(resposta.statusCode).toBe(200);
      const linhas = resposta.json();
      expect(linhas.length).toBeGreaterThan(0);
      expect(linhas[0].detalhes).toEqual({ statusAnterior: "pendente", statusNovo: "agendada" });
    } finally {
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, inserido.recordset[0].id)
        .query("DELETE FROM LogAuditoria WHERE id = @id");
    }
  });
});
