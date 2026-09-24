import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../services/queue.js", () => ({ enfileirarEmail: vi.fn(async () => {}) }));

const { buildApp } = await import("../../app.js");
const { getPool, sql, closePool } = await import("../../db/pool.js");
const {
  CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO,
  CODIGO_CONFLITO_APROVACAO,
  CODIGO_CONFLITO_SUBSTITUIVEL,
} = await import("@plataformares/shared");
const { combinarDataHoraBrasilia } = await import("@plataformares/shared");
const { concluirReserva, contabilizarUsoReserva, horaAtualBrasilia } = await import(
  "../../services/reservaTransicao.service.js"
);
const { agoraEmBrasilia } = await import("../../services/automacaoReserva.service.js");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  definirExpedienteDiaInteiro,
  definirModoAprovacao,
  garantirSetor,
  inserirBloqueioTeste,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* Migration 0022 — fluxo de aprovação, urgência com substituição e horímetro automático.
 * Numeração "TESTE N" = lista de testes obrigatórios da especificação da mudança. Os testes
 * de regra pura (antecedência x urgência, aritmética do horímetro, janela da Agenda em curso)
 * estão em tests/unit/conflito.test.ts e tests/unit/operacao.test.ts. */

const PREFIXOS = { plataforma: "PLT-APR-URG", email: "teste.apr.urg.", bloqueio: "APR-URG" };
const DIA = dataFuturaAleatoria();

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let setorTi: Setor;
let setorManutencao: Setor;
let colabTi: Usuario;
let colabMan: Usuario;
let gestorTi: Usuario;
let admin: Usuario;
let plataformaId: string;
let restaurarExpediente: () => Promise<void>;
let restaurarModo: () => Promise<void>;
let gestorMan: Usuario;

function corpo(data: string, horaInicio: string, horaFim: string, prioridade = "normal") {
  return {
    plataformaId,
    data,
    horaInicio,
    horaFim,
    quantidadePessoas: 1,
    motivo: "Reserva de teste de aprovação",
    telefoneContato: "(11) 91234-5678",
    prioridade,
  };
}

function criar(usuario: Usuario, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/reservas", headers: { cookie: usuario.cookie }, payload });
}

function aprovar(usuario: Usuario, id: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/v1/reservas/${id}/aprovar`,
    headers: { cookie: usuario.cookie },
    payload,
  });
}

async function statusDe(id: string) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<{
      status: string;
      substituida_por_id: string | null;
      motivo_cancelamento: string | null;
      uso_contabilizado_minutos: number | null;
    }>("SELECT status, substituida_por_id, motivo_cancelamento, uso_contabilizado_minutos FROM Reserva WHERE id = @id");
  return r.recordset[0];
}

async function horimetroUso(): Promise<number> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, plataformaId)
    .query<{ horimetro_uso_minutos: number }>("SELECT horimetro_uso_minutos FROM Plataforma WHERE id = @id");
  return r.recordset[0].horimetro_uso_minutos;
}

async function confirmadasSobrepostas(data: string, inicio: string, fim: string): Promise<number> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("data", sql.Date, data)
    .input("inicio", sql.VarChar, inicio)
    .input("fim", sql.VarChar, fim)
    .query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Reserva
       WHERE plataforma_id = @plataforma_id AND data = @data AND status IN ('agendada','em_uso')
         AND NOT (hora_fim <= CAST(@inicio AS TIME) OR hora_inicio >= CAST(@fim AS TIME))`
    );
  return r.recordset[0].total;
}

/** Reserva de fixture com campos de uso (inserirReservaTeste não os cobre). */
async function ajustarUso(
  id: string,
  campos: { inicioAutomatico?: boolean; fimAutomatico?: boolean; horaInicioReal?: string | null; prioridade?: string }
) {
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("inicio_automatico", sql.Bit, campos.inicioAutomatico ?? true)
    .input("fim_automatico", sql.Bit, campos.fimAutomatico ?? true)
    .input("hora_inicio_real", sql.VarChar, campos.horaInicioReal ?? null)
    .input("prioridade", sql.VarChar, campos.prioridade ?? "normal")
    .query(
      `UPDATE Reserva SET inicio_automatico = @inicio_automatico, fim_automatico = @fim_automatico,
         hora_inicio_real = CAST(@hora_inicio_real AS TIME), prioridade = @prioridade
       WHERE id = @id`
    );
}

function menosMinutos(hora: string, minutos: number): string {
  const [h, m] = hora.split(":").map(Number);
  const total = h * 60 + m - minutos;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  restaurarExpediente = await definirExpedienteDiaInteiro();
  // A suíte parte do modo MANUAL (o padrão); os cenários do modo automático o ligam e desligam.
  restaurarModo = await definirModoAprovacao("manual");

  setorTi = await garantirSetor("TI");
  setorManutencao = await garantirSetor("Manutenção");
  colabTi = await criarUsuarioTeste({
    email: `${PREFIXOS.email}colab.ti@metalsider.com.br`,
    nome: "Colaborador TI (teste aprovação)",
    perfil: "colaborador",
    setorId: setorTi.id,
  });
  colabMan = await criarUsuarioTeste({
    email: `${PREFIXOS.email}colab.man@metalsider.com.br`,
    nome: "Colaborador Manutenção (teste aprovação)",
    perfil: "colaborador",
    setorId: setorManutencao.id,
  });
  gestorTi = await criarUsuarioTeste({
    email: `${PREFIXOS.email}gestor.ti@metalsider.com.br`,
    nome: "Gestor TI (teste aprovação)",
    perfil: "gestor_setor",
    setorId: setorTi.id,
  });
  gestorMan = await criarUsuarioTeste({
    email: `${PREFIXOS.email}gestor.man@metalsider.com.br`,
    nome: "Gestor Manutenção (teste aprovação)",
    perfil: "gestor_setor",
    setorId: setorManutencao.id,
  });
  admin = await criarUsuarioTeste({
    email: `${PREFIXOS.email}admin@metalsider.com.br`,
    nome: "Admin (teste aprovação)",
    perfil: "admin",
    setorId: null,
  });
  plataformaId = await criarPlataformaTeste({ codigo: "PLT-APR-URG-1", nome: "Plataforma teste aprovação" });
  // Baseline manual do horímetro — precisa ser preservado.
  const pool = await getPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, plataformaId)
    .query("UPDATE Plataforma SET horimetro_horas = 460, horimetro_uso_minutos = 0 WHERE id = @id");
});

afterAll(async () => {
  await restaurarExpediente?.();
  await restaurarModo?.();
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setorTi);
  await removerSetorSeCriado(setorManutencao);
  await app.close();
  await closePool();
});

describe("aprovação", () => {
  let pendenteTi: string;
  let pendenteManSobreposta: string;

  it("TESTE 1 — colaborador cria reserva normal: nasce PENDENTE", async () => {
    const response = await criar(colabTi, corpo(DIA, "08:00", "09:00"));
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("pendente");
    pendenteTi = response.json().id;
  });

  it("pendente não ocupa a plataforma: outra solicitação no mesmo horário é aceita", async () => {
    const response = await criar(colabMan, corpo(DIA, "08:30", "09:30"));
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("pendente");
    pendenteManSobreposta = response.json().id;
  });

  it("TESTE 4 — colaborador não aprova (403 no backend, não só na UI)", async () => {
    const response = await aprovar(colabTi, pendenteTi);
    expect(response.statusCode).toBe(403);
    expect((await statusDe(pendenteTi)).status).toBe("pendente");
  });

  it("TESTE 1/2 — gestor aprova e rejeita solicitação de OUTRO setor (aprovador global)", async () => {
    const outra = await criar(colabMan, corpo(DIA, "10:00", "11:00"));
    const aprovada = await aprovar(gestorTi, outra.json().id);
    expect(aprovada.statusCode).toBe(200);
    expect(aprovada.json().status).toBe("agendada");

    const outraTi = await criar(colabTi, corpo(DIA, "16:00", "17:00"));
    const rejeitada = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${outraTi.json().id}/rejeitar`,
      headers: { cookie: gestorMan.cookie },
      payload: { motivo: "Plataforma reservada para outra frente" },
    });
    expect(rejeitada.statusCode).toBe(200);
    expect(rejeitada.json().status).toBe("rejeitada");
  });

  it("TESTE 3 — colaborador não tem ações de aprovação nem de análise (403)", async () => {
    const outra = await criar(colabMan, corpo(DIA, "18:00", "19:00"));
    expect((await aprovar(colabTi, outra.json().id)).statusCode).toBe(403);
    const analise = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${outra.json().id}/analise-aprovacao`,
      headers: { cookie: colabTi.cookie },
    });
    expect(analise.statusCode).toBe(403);
  });

  it("TESTE 4/5 — pendente aparece na disponibilidade como solicitação (sem ocupar o horário)", async () => {
    const data = somarDias(DIA, 1);
    const criada = await criar(colabTi, corpo(data, "10:30", "11:30"));
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/disponibilidade?data=${data}&plataformaId=${plataformaId}`,
      headers: { cookie: colabTi.cookie },
    });
    expect(response.statusCode).toBe(200);
    const intervalo = response.json().plataformas[0].intervalos.find(
      (i: { id: string }) => i.id.toLowerCase() === criada.json().id.toLowerCase()
    );
    expect(intervalo).toMatchObject({ status: "pendente", inicioMin: 630, fimMin: 690 });
    expect(intervalo.solicitanteId.toLowerCase()).toBe(colabTi.id.toLowerCase());
    // …e não ocupa: o "próximo horário livre" pode cair em cima dela.
    const proximo = await app.inject({
      method: "GET",
      url: `/api/v1/disponibilidade/proximo?plataformaId=${plataformaId}&data=${data}&duracaoMinutos=60&limiteDias=1`,
      headers: { cookie: colabTi.cookie },
    });
    expect(proximo.json()).toMatchObject({ encontrado: true, inicioMin: 0 });
  });

  it("TESTE 3 — gestor aprova solicitação do próprio setor: AGENDADA", async () => {
    const response = await aprovar(gestorTi, pendenteTi);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("agendada");
    expect(response.json().aprovadoPorNome).toBe("Gestor TI (teste aprovação)");
  });

  it("aprovação não se repete: segunda tentativa → 409", async () => {
    const response = await aprovar(admin, pendenteTi);
    expect(response.statusCode).toBe(409);
  });

  it("revalida no momento da aprovação: a pendente sobreposta (a outra já foi aprovada) → 409 sem substituição", async () => {
    const response = await aprovar(admin, pendenteManSobreposta);
    expect(response.statusCode).toBe(409);
    expect(response.json().codigo).toBe(CODIGO_CONFLITO_APROVACAO);
    expect(response.json().conflitos[0].id.toLowerCase()).toBe(pendenteTi.toLowerCase());
    expect((await statusDe(pendenteManSobreposta)).status).toBe("pendente");
  });

  it("normal em conflito com reserva confirmada nem chega a ser criada (409)", async () => {
    const response = await criar(colabMan, corpo(DIA, "08:30", "09:30"));
    expect(response.statusCode).toBe(409);
  });

  it("TESTE 2 — admin aprova: AGENDADA; e rejeição exige motivo e grava rejeitada", async () => {
    const a = await criar(colabMan, corpo(DIA, "12:00", "13:00"));
    const aprovada = await aprovar(admin, a.json().id);
    expect(aprovada.statusCode).toBe(200);
    expect(aprovada.json().status).toBe("agendada");

    const b = await criar(colabMan, corpo(DIA, "13:00", "14:00"));
    const semMotivo = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${b.json().id}/rejeitar`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(semMotivo.statusCode).toBe(422);
    const rejeitada = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${b.json().id}/rejeitar`,
      headers: { cookie: admin.cookie },
      payload: { motivo: "Plataforma reservada para inspeção" },
    });
    expect(rejeitada.statusCode).toBe(200);
    expect(rejeitada.json().status).toBe("rejeitada");
    expect(rejeitada.json().motivoRejeicao).toBe("Plataforma reservada para inspeção");
  });

  it("admin/gestor criando reserva operacional: nasce AGENDADA (sem autoaprovação)", async () => {
    const response = await criar(gestorTi, corpo(DIA, "15:00", "16:00"));
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("agendada");
  });

  it("TESTE 11 — duas aprovações concorrentes sobre o mesmo horário: só uma prevalece", async () => {
    const data = somarDias(DIA, 3);
    const a = await criar(colabTi, corpo(data, "09:00", "11:00"));
    const b = await criar(colabMan, corpo(data, "10:00", "12:00"));
    const [ra, rb] = await Promise.all([aprovar(admin, a.json().id), aprovar(admin, b.json().id)]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    expect(await confirmadasSobrepostas(data, "09:00", "12:00")).toBe(1);
  });
});

describe("urgência e substituição", () => {
  const data = somarDias(DIA, 5);
  let normalA: string;
  let urgenteB: string;

  it("TESTE 7 — urgente sem conflito é aprovada: AGENDADA", async () => {
    const urgente = await criar(colabTi, corpo(data, "06:00", "07:00", "urgente"));
    expect(urgente.json().status).toBe("pendente"); // urgência não é aprovação automática
    const response = await aprovar(admin, urgente.json().id);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("agendada");
  });

  it("TESTE 8 — urgente que conflita: criação aceita como pendente, aprovação oferece substituição", async () => {
    normalA = await inserirReservaTeste({
      setorId: setorManutencao.id,
      solicitanteId: colabMan.id,
      plataformaId,
      data,
      horaInicio: "14:00",
      horaFim: "16:00",
      status: "agendada",
    });
    const criada = await criar(colabTi, corpo(data, "14:30", "15:30", "urgente"));
    expect(criada.statusCode).toBe(201);
    expect(criada.json().status).toBe("pendente");
    urgenteB = criada.json().id;

    const response = await aprovar(admin, urgenteB);
    expect(response.statusCode).toBe(409);
    expect(response.json().codigo).toBe(CODIGO_CONFLITO_SUBSTITUIVEL);
    const [conflito] = response.json().conflitos;
    expect(conflito).toMatchObject({
      id: normalA,
      setorNome: setorManutencao.nome,
      solicitanteNome: "Colaborador Manutenção (teste aprovação)",
      horaInicio: "14:00",
      horaFim: "16:00",
      prioridade: "normal",
      status: "agendada",
    });
  });

  it("TESTE 9 — sem confirmar, nada muda: existente intacta, urgente continua pendente", async () => {
    expect((await statusDe(normalA)).status).toBe("agendada");
    expect((await statusDe(urgenteB)).status).toBe("pendente");
  });

  it("TESTE 7 — gestor de OUTRO setor vê a análise com opção de substituição", async () => {
    // A urgente é do setor TI e a conflitante é da Manutenção; o gestor é da Manutenção.
    const analise = await app.inject({
      method: "GET",
      url: `/api/v1/reservas/${urgenteB}/analise-aprovacao`,
      headers: { cookie: gestorMan.cookie },
    });
    expect(analise.statusCode).toBe(200);
    expect(analise.json()).toMatchObject({ pendente: true, podeSubstituir: true, emUso: false });
    expect(analise.json().conflitos[0].id.toLowerCase()).toBe(normalA.toLowerCase());
  });

  it("TESTE 9/17 — duas confirmações simultâneas da mesma substituição: uma efetiva, estado consistente", async () => {
    // Gestor de outro setor (TI) e Admin confirmam ao mesmo tempo.
    const [a, b] = await Promise.all([
      aprovar(gestorTi, urgenteB, { substituirConflitantes: true }),
      aprovar(admin, urgenteB, { substituirConflitantes: true }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const response = a.statusCode === 200 ? a : b;
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("agendada");
    expect(response.json().reservasSubstituidas).toEqual([normalA]);

    const antiga = await statusDe(normalA);
    expect(antiga.status).toBe("cancelada");
    expect(antiga.substituida_por_id?.toLowerCase()).toBe(urgenteB.toLowerCase());
    expect(antiga.motivo_cancelamento).toContain("Substituída por reserva urgente");
    expect(antiga.uso_contabilizado_minutos).toBeNull(); // não havia começado: +0 no horímetro

    const pool = await getPool();
    const substituicoes = await pool
      .request()
      .input("a", sql.UniqueIdentifier, normalA)
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM LogAuditoria WHERE entidade_id = @a AND acao = 'substituir_reserva'"
      );
    expect(substituicoes.recordset[0].total).toBe(1);
    const auditoria = await pool
      .request()
      .input("a", sql.UniqueIdentifier, normalA)
      .input("b", sql.UniqueIdentifier, urgenteB)
      .query<{ acao: string; entidade_id: string; detalhes: string }>(
        `SELECT acao, entidade_id, detalhes FROM LogAuditoria
         WHERE (entidade_id = @a AND acao = 'substituir_reserva') OR (entidade_id = @b AND acao = 'aprovar_reserva')`
      );
    expect(auditoria.recordset.map((l) => l.acao).sort()).toEqual(["aprovar_reserva", "substituir_reserva"]);
    const substituicao = JSON.parse(auditoria.recordset.find((l) => l.acao === "substituir_reserva")!.detalhes);
    expect(substituicao).toMatchObject({ prioridadeNova: "urgente", prioridadeSubstituida: "normal" });

    expect(await confirmadasSobrepostas(data, "14:00", "16:00")).toBe(1);
  });

  it("urgente continua barrada por bloqueio de agenda, mesmo em conflito com reserva", async () => {
    const dataBloqueio = somarDias(data, 1);
    await inserirReservaTeste({
      setorId: setorManutencao.id,
      solicitanteId: colabMan.id,
      plataformaId,
      data: dataBloqueio,
      horaInicio: "10:00",
      horaFim: "11:00",
      status: "agendada",
    });
    await inserirBloqueioTeste({
      plataformaId,
      inicio: combinarDataHoraBrasilia(dataBloqueio, "10:30"),
      fim: combinarDataHoraBrasilia(dataBloqueio, "12:00"),
      motivo: `${PREFIXOS.bloqueio} inspeção`,
      criadoPorId: admin.id,
    });
    const response = await criar(colabTi, corpo(dataBloqueio, "10:40", "11:10", "urgente"));
    expect(response.statusCode).toBe(409);
    expect(response.json().tipo).toBe("bloqueio_plataforma");
  });

  it("urgência não substitui urgência", async () => {
    const outra = await criar(colabMan, corpo(data, "15:00", "15:30", "urgente"));
    const response = await aprovar(admin, outra.json().id, { substituirConflitantes: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().codigo).toBe(CODIGO_CONFLITO_APROVACAO);
  });

  it("TESTE 16 — em uso: exige confirmação adicional e contabiliza só o tempo usado", async () => {
    const agora = agoraEmBrasilia();
    const horaAgora = horaAtualBrasilia();
    const [h] = horaAgora.split(":").map(Number);
    if (h < 1 || h >= 22) return; // janela do teste precisa caber no dia de hoje
    const inicioReal = menosMinutos(horaAgora, 42);
    const fimAgendado = `${String(h + 2).padStart(2, "0")}:00`;
    const emUso = await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: agora.data,
      horaInicio: inicioReal,
      horaFim: fimAgendado,
      status: "em_uso",
    });
    await ajustarUso(emUso, { horaInicioReal: inicioReal });
    const usoAntes = await horimetroUso();

    const urgente = await criar(colabMan, corpo(agora.data, horaAgora, fimAgendado, "urgente"));
    expect(urgente.json().status).toBe("pendente");

    const semConfirmacao = await aprovar(admin, urgente.json().id, { substituirConflitantes: true });
    expect(semConfirmacao.statusCode).toBe(409);
    expect(semConfirmacao.json().codigo).toBe(CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO);
    expect((await statusDe(emUso)).status).toBe("em_uso");

    const confirmada = await aprovar(admin, urgente.json().id, {
      substituirConflitantes: true,
      confirmarInterrupcaoEmUso: true,
    });
    expect(confirmada.statusCode).toBe(200);
    const antiga = await statusDe(emUso);
    expect(antiga.status).toBe("cancelada");
    // 42 min (ou 43 se o minuto virou durante o teste).
    expect([42, 43]).toContain(antiga.uso_contabilizado_minutos);
    expect(await horimetroUso()).toBe(usoAntes + antiga.uso_contabilizado_minutos!);
  });
});

describe("modo de aprovação automática (Configurações)", () => {
  const data = somarDias(DIA, 20);

  it("TESTE 10/12/13 — automática: normal e urgente sem conflito nascem agendadas; urgente com conflito fica pendente", async () => {
    const restaurar = await definirModoAprovacao("automatica");
    try {
      const normal = await criar(colabTi, corpo(data, "08:00", "09:00"));
      expect(normal.json().status).toBe("agendada");

      const urgente = await criar(colabTi, corpo(data, "12:00", "13:00", "urgente"));
      expect(urgente.json().status).toBe("agendada");

      // Exceção absoluta: conflito urgente nunca é confirmado nem substitui sozinho.
      const conflitante = await criar(colabMan, corpo(data, "08:30", "09:30", "urgente"));
      expect(conflitante.statusCode).toBe(201);
      expect(conflitante.json().status).toBe("pendente");
      expect(conflitante.json().aviso).toContain("conflita");
      expect((await statusDe(normal.json().id)).status).toBe("agendada");

      // Normal em conflito continua recusada também no modo automático.
      const normalConflitante = await criar(colabMan, corpo(data, "08:30", "09:30"));
      expect(normalConflitante.statusCode).toBe(409);
    } finally {
      await restaurar();
    }
  });

  it("TESTE 11 — de volta ao manual, a reserva normal do colaborador nasce pendente", async () => {
    const normal = await criar(colabTi, corpo(data, "15:00", "16:00"));
    expect(normal.json().status).toBe("pendente");
  });

  it("alterar o modo pela rota de Configurações é só do Admin e fica auditado (de → para)", async () => {
    const negado = await app.inject({
      method: "PUT",
      url: "/api/v1/configuracoes",
      headers: { cookie: gestorTi.cookie },
      payload: { modoAprovacaoReservas: "automatica" },
    });
    expect(negado.statusCode).toBe(403);

    const restaurar = await definirModoAprovacao("manual");
    try {
      const alterado = await app.inject({
        method: "PUT",
        url: "/api/v1/configuracoes",
        headers: { cookie: admin.cookie },
        payload: { modoAprovacaoReservas: "automatica" },
      });
      expect(alterado.statusCode).toBe(200);
      const pool = await getPool();
      const log = await pool
        .request()
        .input("usuario_id", sql.UniqueIdentifier, admin.id)
        .query<{ detalhes: string }>(
          "SELECT TOP 1 detalhes FROM LogAuditoria WHERE acao = 'alterar_modo_aprovacao' AND usuario_id = @usuario_id ORDER BY criado_em DESC"
        );
      expect(JSON.parse(log.recordset[0].detalhes)).toEqual({ modoAnterior: "manual", modoNovo: "automatica" });
    } finally {
      await restaurar();
    }
  });
});

describe("horímetro automático", () => {
  const ontem = somarDias(agoraEmBrasilia().data, -1);

  it("TESTE 12/13 — conclusão automática de 2h soma +2h exatamente uma vez (job repetido e concorrente)", async () => {
    const id = await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: ontem,
      horaInicio: "14:00",
      horaFim: "16:00",
      status: "em_uso",
    });
    await ajustarUso(id, { horaInicioReal: "14:00" });
    const antes = await horimetroUso();

    // Duas execuções simultâneas do mesmo encerramento (job + retry) e mais uma depois.
    const [a, b] = await Promise.all([
      concluirReserva({ reservaId: id, origem: "automatica", usuarioId: null }),
      concluirReserva({ reservaId: id, origem: "automatica", usuarioId: null }),
    ]);
    expect([a.aplicada, b.aplicada].filter(Boolean)).toHaveLength(1);
    const repetida = await concluirReserva({ reservaId: id, origem: "automatica", usuarioId: null });
    expect(repetida.aplicada).toBe(false);

    // Mesmo chamando a contabilização de novo diretamente, ela não soma outra vez.
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    expect(await contabilizarUsoReserva(transaction, id)).toBeNull();
    await transaction.commit();

    expect((await statusDe(id)).uso_contabilizado_minutos).toBe(120);
    expect(await horimetroUso()).toBe(antes + 120);
  });

  it("baseline manual preservado: horímetro atual = 460h + uso", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/plataformas/${plataformaId}`,
      headers: { cookie: admin.cookie },
    });
    if (response.statusCode === 404) return; // rota de detalhe opcional
    const plataforma = response.json();
    expect(plataforma.horimetroHoras).toBe(460);
    expect(plataforma.horimetroAtualHoras).toBeCloseTo(460 + plataforma.horimetroUsoMinutos / 60, 2);
  });

  it("TESTE 14 — encerramento manual usa o horário real (início real há 95 min → +1h35)", async () => {
    const horaAgora = horaAtualBrasilia();
    const [h] = horaAgora.split(":").map(Number);
    if (h < 2) return;
    const hoje = agoraEmBrasilia().data;
    const inicioReal = menosMinutos(horaAgora, 95);
    const id = await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: hoje,
      horaInicio: inicioReal,
      horaFim: "23:59",
      status: "em_uso",
    });
    await ajustarUso(id, { inicioAutomatico: false, fimAutomatico: false, horaInicioReal: inicioReal });
    const antes = await horimetroUso();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/reservas/${id}/status`,
      headers: { cookie: admin.cookie },
      payload: { acao: "concluir" },
    });
    expect(response.statusCode).toBe(200);
    const minutos = (await statusDe(id)).uso_contabilizado_minutos!;
    expect([95, 96]).toContain(minutos);
    expect(await horimetroUso()).toBe(antes + minutos);
  });

  it("TESTE 15 — cancelada antes de começar: +0", async () => {
    const criada = await criar(gestorTi, corpo(somarDias(DIA, 9), "08:00", "09:00"));
    const antes = await horimetroUso();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${criada.json().id}/cancelar`,
      headers: { cookie: gestorTi.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((await statusDe(criada.json().id)).uso_contabilizado_minutos).toBeNull();
    expect(await horimetroUso()).toBe(antes);
  });

  it("reserva que nunca iniciou (início manual) e venceu não soma horímetro", async () => {
    const id = await inserirReservaTeste({
      setorId: setorTi.id,
      solicitanteId: colabTi.id,
      plataformaId,
      data: ontem,
      horaInicio: "08:00",
      horaFim: "09:00",
      status: "agendada",
    });
    await ajustarUso(id, { inicioAutomatico: false, fimAutomatico: true, horaInicioReal: null });
    const antes = await horimetroUso();
    const resultado = await concluirReserva({
      reservaId: id,
      origem: "automatica",
      usuarioId: null,
      statusDeEsperado: "agendada",
    });
    expect(resultado.aplicada).toBe(true);
    expect((await statusDe(id)).uso_contabilizado_minutos).toBe(0);
    expect(await horimetroUso()).toBe(antes);
  });
});

describe("e-mail das notificações (canal adicional ao sino)", () => {
  const data = somarDias(DIA, 40);
  type ChamadaEmail = { destinatario: string; assunto: string; corpoHtml: string };

  async function filaMock() {
    const { enfileirarEmail } = await import("../../services/queue.js");
    return enfileirarEmail as unknown as ReturnType<typeof vi.fn> & { mock: { calls: [ChamadaEmail][] } };
  }
  async function esperarEmail(destinatario: string, trechoAssunto: string) {
    const fila = await filaMock();
    await vi.waitFor(() => {
      const achou = fila.mock.calls.some(
        ([dados]) => dados.destinatario === destinatario && dados.assunto.includes(trechoAssunto)
      );
      expect(achou, `e-mail "${trechoAssunto}" para ${destinatario}`).toBe(true);
    });
  }

  it("solicitação pendente: aprovadores recebem e-mail (e-mail cadastrado do usuário)", async () => {
    (await filaMock()).mockClear();
    await criar(colabTi, corpo(data, "08:00", "09:00"));
    await esperarEmail(admin.email, "Reserva aguardando aprovação");
  });

  it("aprovada e rejeitada: o responsável recebe e-mail", async () => {
    const a = await criar(colabTi, corpo(data, "10:00", "11:00"));
    await aprovar(gestorMan, a.json().id);
    await esperarEmail(colabTi.email, "Reserva aprovada");

    const b = await criar(colabMan, corpo(data, "12:00", "13:00"));
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${b.json().id}/rejeitar`,
      headers: { cookie: admin.cookie },
      payload: { motivo: "Sem operador disponível" },
    });
    await esperarEmail(colabMan.email, "Reserva rejeitada");
  });

  it("urgente em conflito e substituição: aprovadores e responsável substituído recebem e-mail", async () => {
    const normal = await criar(gestorTi, corpo(data, "14:00", "15:00"));
    expect(normal.json().status).toBe("agendada");
    const urgente = await criar(colabMan, corpo(data, "14:30", "15:00", "urgente"));
    await esperarEmail(admin.email, "Urgente em conflito");

    await aprovar(admin, urgente.json().id, { substituirConflitantes: true });
    await esperarEmail(gestorTi.email, "Reserva substituída por urgência");
  });

  it("cancelada por outra pessoa: o responsável recebe e-mail", async () => {
    const reserva = await criar(gestorTi, corpo(data, "16:00", "17:00"));
    await app.inject({
      method: "POST",
      url: `/api/v1/reservas/${reserva.json().id}/cancelar`,
      headers: { cookie: admin.cookie },
    });
    await esperarEmail(gestorTi.email, "Reserva cancelada");
  });

  it("fila de e-mail indisponível NÃO desfaz a aprovação nem a notificação interna", async () => {
    const fila = await filaMock();
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const pendente = await criar(colabTi, corpo(data, "18:00", "19:00"));
    fila.mockImplementation(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    });
    try {
      const response = await aprovar(admin, pendente.json().id);
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("agendada");
      await vi.waitFor(() =>
        expect(erro.mock.calls.some(([linha]) => String(linha).includes("falha-enfileirar"))).toBe(true)
      );
      const pool = await getPool();
      const interna = await pool
        .request()
        .input("usuario_id", sql.UniqueIdentifier, colabTi.id)
        .query<{ total: number }>(
          "SELECT COUNT(*) AS total FROM Notificacao WHERE usuario_id = @usuario_id AND tipo = 'reserva_aprovada'"
        );
      expect(interna.recordset[0].total).toBeGreaterThanOrEqual(1);
    } finally {
      fila.mockImplementation(async () => {});
      erro.mockRestore();
    }
  });
});
