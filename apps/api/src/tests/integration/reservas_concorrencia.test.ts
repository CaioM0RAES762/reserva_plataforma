import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const { definirProviderEmailParaTeste } = await import("../../services/email.service.js");
const { criarProviderMockSempreAceita } = await import("../helpers/emailProviderMock.js");
const { CODIGO_ERRO_HORARIO_INDISPONIVEL, combinarDataHoraBrasilia } = await import("@plataformares/shared");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  inserirBloqueioTeste,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
  definirExpedienteDiaInteiro,
} = await import("../helpers/agendaFixtures.js");

// Conflito de horário no POST /reservas: o corpo do 409 carrega `codigo` estável (o front troca
// a mensagem técnica por "esse horário acabou de ficar indisponível") e o modelo de
// concorrência (UPDLOCK/HOLDLOCK na transação) garante que, entre requisições simultâneas
// para o mesmo slot, exatamente UMA vence.

const PREFIXOS = { plataforma: "PLT-AGD-CNC", email: "teste.agd.cnc.", bloqueio: "AGD-CNC" };
const DIA = dataFuturaAleatoria();

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let setorTi: Setor;
let setorManutencao: Setor;
let colabTi: Usuario;
let colabMan: Usuario;
let admin: Usuario;
let plataformaId: string;
let restaurarExpediente: () => Promise<void>;

function corpo(data: string, horaInicio: string, horaFim: string, extra: Record<string, unknown> = {}) {
  return {
    plataformaId,
    data,
    horaInicio,
    horaFim,
    quantidadePessoas: 1,
    motivo: "Reserva de teste de concorrência",
    telefoneContato: "(11) 91234-5678",
    // Normal: urgência em conflito vira solicitação pendente (migration 0022) em vez de 409.
    // O expediente de dia inteiro (beforeAll) tira a dependência da configuração do banco.
    prioridade: "normal",
    ...extra,
  };
}

function criar(usuario: Usuario, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/reservas", headers: { cookie: usuario.cookie }, payload });
}

async function contarReservasAtivas(data: string, horaInicio: string): Promise<number> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("data", sql.Date, data)
    .input("hora_inicio", sql.VarChar, horaInicio)
    .query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Reserva
       WHERE plataforma_id = @plataforma_id AND data = @data AND hora_inicio = @hora_inicio
         AND status IN ('pendente','agendada','em_uso')`
    );
  return r.recordset[0].total;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  definirProviderEmailParaTeste(criarProviderMockSempreAceita());

  await limparResiduos(PREFIXOS);
  restaurarExpediente = await definirExpedienteDiaInteiro();

  setorTi = await garantirSetor("TI");
  setorManutencao = await garantirSetor("Manutenção");
  colabTi = await criarUsuarioTeste({
    email: `${PREFIXOS.email}ti@metalsider.com.br`,
    nome: "Gestor TI (teste concorrência)",
    // Gestor: a reserva nasce AGENDADA (confirmada) — é a corrida entre confirmadas que
    // esta suíte mede. Colaborador criaria pendente, que não ocupa horário.
    perfil: "gestor_setor",
    setorId: setorTi.id,
  });
  colabMan = await criarUsuarioTeste({
    email: `${PREFIXOS.email}man@metalsider.com.br`,
    nome: "Gestor Manutenção (teste concorrência)",
    perfil: "gestor_setor",
    setorId: setorManutencao.id,
  });
  admin = await criarUsuarioTeste({
    email: `${PREFIXOS.email}admin@metalsider.com.br`,
    nome: "Admin (teste concorrência)",
    perfil: "admin",
    setorId: null,
  });
  plataformaId = await criarPlataformaTeste({
    codigo: "PLT-AGD-CNC-1",
    nome: "Plataforma teste concorrência",
    capacidadeOperadores: 2,
  });
});

afterAll(async () => {
  definirProviderEmailParaTeste(null);
  await restaurarExpediente?.();
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setorTi);
  await removerSetorSeCriado(setorManutencao);
  await app.close();
  await closePool();
});

describe("POST /reservas — 409 de horário indisponível carrega `codigo`", () => {
  it("conflito com reserva existente: codigo + tipo + mensagem original preservados", async () => {
    const primeira = await criar(colabTi, corpo(DIA, "09:00", "10:00"));
    expect(primeira.statusCode).toBe(201);

    const conflito = await criar(colabMan, corpo(DIA, "09:30", "10:30"));
    expect(conflito.statusCode).toBe(409);
    const resposta = conflito.json();
    expect(resposta.codigo).toBe(CODIGO_ERRO_HORARIO_INDISPONIVEL);
    expect(resposta.tipo).toBe("conflito_reserva");
    expect(resposta.erro).toContain("Conflito de horário");
    expect(resposta.erro).toContain(setorTi.nome);
  });

  it("adjacência exata (fim == início da outra) NÃO é conflito", async () => {
    const adjacente = await criar(colabMan, corpo(DIA, "10:00", "11:00"));
    expect(adjacente.statusCode).toBe(201);
  });

  it("reserva 'concluida' não bloqueia um novo pedido no mesmo horário (mesma regra do /proximo)", async () => {
    await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: DIA,
      horaInicio: "13:00",
      horaFim: "14:00",
      status: "concluida",
    });
    const response = await criar(colabMan, corpo(DIA, "13:00", "14:00"));
    expect(response.statusCode).toBe(201);
  });

  it("bloqueio da plataforma: codigo + tipo bloqueio_plataforma + dados do bloqueio", async () => {
    await inserirBloqueioTeste({
      plataformaId,
      inicio: combinarDataHoraBrasilia(DIA, "15:00"),
      fim: combinarDataHoraBrasilia(DIA, "16:00"),
      motivo: `${PREFIXOS.bloqueio} plataforma`,
      criadoPorId: admin.id,
    });
    const response = await criar(colabTi, corpo(DIA, "15:30", "16:30"));
    expect(response.statusCode).toBe(409);
    const resposta = response.json();
    expect(resposta.codigo).toBe(CODIGO_ERRO_HORARIO_INDISPONIVEL);
    expect(resposta.tipo).toBe("bloqueio_plataforma");
    expect(resposta.bloqueio.motivo).toBe(`${PREFIXOS.bloqueio} plataforma`);
  });

  it("bloqueio global: codigo + tipo bloqueio_global", async () => {
    await inserirBloqueioTeste({
      plataformaId: null,
      inicio: combinarDataHoraBrasilia(DIA, "17:00"),
      fim: combinarDataHoraBrasilia(DIA, "18:00"),
      motivo: `${PREFIXOS.bloqueio} global`,
      criadoPorId: admin.id,
    });
    const response = await criar(colabTi, corpo(DIA, "17:00", "17:30"));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ codigo: CODIGO_ERRO_HORARIO_INDISPONIVEL, tipo: "bloqueio_global" });
  });

  it("bloqueio que cobre só a noite de Brasília (21:00–24:00, já é o dia seguinte em UTC) também barra a reserva", async () => {
    // Regressão: a busca de bloqueios comparava contra a meia-noite UTC e perdia estes 3h.
    await inserirBloqueioTeste({
      plataformaId,
      inicio: combinarDataHoraBrasilia(DIA, "21:00"),
      fim: combinarDataHoraBrasilia(somarDias(DIA, 1), "00:00"),
      motivo: `${PREFIXOS.bloqueio} noite`,
      criadoPorId: admin.id,
    });
    const response = await criar(colabTi, corpo(DIA, "22:00", "23:00"));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ codigo: CODIGO_ERRO_HORARIO_INDISPONIVEL, tipo: "bloqueio_plataforma" });
  });

  it("série semanal que esbarra em conflito também devolve o codigo (com a data da ocorrência na mensagem)", async () => {
    // A 2ª ocorrência (DIA + 7) cai sobre uma reserva já existente.
    await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: somarDias(DIA, 7),
      horaInicio: "07:00",
      horaFim: "08:00",
      status: "agendada",
    });
    const response = await criar(colabMan, corpo(DIA, "07:00", "08:00", { recorrencia: { quantidadeOcorrencias: 2 } }));
    expect(response.statusCode).toBe(409);
    expect(response.json().codigo).toBe(CODIGO_ERRO_HORARIO_INDISPONIVEL);
    expect(response.json().erro).toContain(somarDias(DIA, 7));
    // Nada da série foi criada (transação revertida).
    expect(await contarReservasAtivas(DIA, "07:00")).toBe(0);
  });

  it("409 que NÃO é de horário (capacidade da plataforma) não leva `codigo`", async () => {
    const response = await criar(colabTi, corpo(DIA, "06:00", "06:30", { quantidadePessoas: 3 }));
    expect(response.statusCode).toBe(409);
    expect(response.json().erro).toContain("capacidade");
    expect(response.json()).not.toHaveProperty("codigo");
  });
});

describe("POST /reservas — concorrência no mesmo slot", () => {
  it("duas requisições simultâneas para o mesmo horário: exatamente um 201 e um 409 com codigo", async () => {
    const [a, b] = await Promise.all([
      criar(colabTi, corpo(somarDias(DIA, 20), "08:00", "09:00")),
      criar(colabMan, corpo(somarDias(DIA, 20), "08:00", "09:00")),
    ]);
    const status = [a.statusCode, b.statusCode].sort();
    expect(status).toEqual([201, 409]);

    const perdedora = a.statusCode === 409 ? a : b;
    expect(perdedora.json().codigo).toBe(CODIGO_ERRO_HORARIO_INDISPONIVEL);
    expect(await contarReservasAtivas(somarDias(DIA, 20), "08:00")).toBe(1);
  });

  it("repetido em várias rodadas (slots diferentes): nunca 500, nunca dois 201", async () => {
    for (let rodada = 0; rodada < 4; rodada += 1) {
      const data = somarDias(DIA, 30 + rodada);
      const [a, b] = await Promise.all([
        criar(colabTi, corpo(data, "10:00", "12:00")),
        criar(colabMan, corpo(data, "11:00", "13:00")), // sobreposição parcial, não idêntica
      ]);
      expect([a.statusCode, b.statusCode].sort(), `rodada ${rodada}`).toEqual([201, 409]);
      const total =
        (await contarReservasAtivas(data, "10:00")) + (await contarReservasAtivas(data, "11:00"));
      expect(total, `rodada ${rodada}`).toBe(1);
    }
  });

  it("seis simultâneas: uma vence, cinco recebem 409 com codigo, e o banco tem uma só reserva", async () => {
    const data = somarDias(DIA, 40);
    const usuarios = [colabTi, colabMan, colabTi, colabMan, colabTi, colabMan];
    const respostas = await Promise.all(usuarios.map((u) => criar(u, corpo(data, "14:00", "15:00"))));

    const codigos = respostas.map((r) => r.statusCode);
    expect(codigos.filter((c) => c === 201)).toHaveLength(1);
    expect(codigos.filter((c) => c === 409)).toHaveLength(5);
    for (const resposta of respostas.filter((r) => r.statusCode === 409)) {
      expect(resposta.json().codigo).toBe(CODIGO_ERRO_HORARIO_INDISPONIVEL);
    }
    expect(await contarReservasAtivas(data, "14:00")).toBe(1);
  });

  it("horários diferentes e sem sobreposição, simultâneos, passam todos (o lock não serializa o que não conflita)", async () => {
    const data = somarDias(DIA, 41);
    const respostas = await Promise.all([
      criar(colabTi, corpo(data, "08:00", "09:00")),
      criar(colabMan, corpo(data, "09:00", "10:00")),
      criar(colabTi, corpo(data, "10:00", "11:00")),
    ]);
    expect(respostas.map((r) => r.statusCode)).toEqual([201, 201, 201]);
  });
});
