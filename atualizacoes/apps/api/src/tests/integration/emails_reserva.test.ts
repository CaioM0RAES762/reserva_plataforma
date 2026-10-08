import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../../app.js");
const { closePool } = await import("../../db/pool.js");
// Mock global (tests/setup/semFilaDeEmailReal.ts): nada vai para a fila real nem para SMTP.
const { enfileirarEmail } = await import("../../services/queue.js");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  definirModoAprovacao,
  garantirSetor,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* E-mails de reserva: quem recebe em cada evento. O provedor externo nunca é chamado — a
 * asserção é sobre o que entra na fila (destinatário, assunto, corpo). */

const PREFIXOS = { plataforma: "PLT-EMAILRES", email: "teste.emailres.", bloqueio: "EMAILRES" };
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;
type Email = { destinatario: string; assunto: string; corpoHtml: string };

let app: FastifyInstance;
let setor: Awaited<ReturnType<typeof garantirSetor>>;
let admin: Usuario;
let colabA: Usuario;
let colabB: Usuario;
let plataforma: string;
let restaurarModo: () => Promise<void>;
const enfileirados = vi.mocked(enfileirarEmail);
// Um dia distinto por cenário (base sorteada uma vez): dias sorteados independentemente podiam
// coincidir na mesma plataforma e gerar conflito entre cenários.
let diaBase: string | null = null;
let sequenciaDia = 0;
const proximoDia = () => {
  diaBase ??= dataFuturaAleatoria();
  sequenciaDia += 1;
  return somarDias(diaBase, sequenciaDia * 3);
};

const req = (u: Usuario, method: "POST" | "GET", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, payload, headers: { cookie: u.cookie } });

/** E-mails de reserva enfileirados para os usuários DESTA suíte (aprovadores reais do banco de dev ficam de fora). */
async function emailsPara(...usuarios: Usuario[]): Promise<Email[]> {
  const enderecos = new Set(usuarios.map((u) => u.email.toLowerCase()));
  // O despacho roda depois do commit, sem await na rota: espera assentar.
  await new Promise((r) => setTimeout(r, 300));
  return enfileirados.mock.calls.map(([dados]) => dados as Email).filter((e) => enderecos.has(e.destinatario.toLowerCase()));
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  setor = await garantirSetor("Manutenção");
  const u = (s: string, perfil: "admin" | "colaborador") =>
    criarUsuarioTeste({ email: `${PREFIXOS.email}${s}@metalsider.com.br`, nome: `Email ${s}`, perfil, setorId: setor.id });
  admin = await u("admin", "admin");
  colabA = await u("colab.a", "colaborador");
  colabB = await u("colab.b", "colaborador");
  plataforma = await criarPlataformaTeste({ codigo: `${PREFIXOS.plataforma}-1`, nome: "Plataforma e-mail" });
  restaurarModo = await definirModoAprovacao("manual");
});

afterAll(async () => {
  await restaurarModo?.();
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(setor);
  await app.close();
  await closePool();
});

beforeEach(() => enfileirados.mockClear());

const base = { quantidadePessoas: 1, motivo: "Teste e-mail", telefoneContato: "31999999999" };

describe("reserva criada", () => {
  it("Admin criando (já agendada) recebe a confirmação com o período de vários dias", async () => {
    const dia = proximoDia();
    const r = await req(admin, "POST", "/api/v1/reservas", {
      ...base, setorId: setor.id, plataformaId: plataforma, data: dia, dataFim: somarDias(dia, 2), horaInicio: "08:00", horaFim: "17:00",
    });
    expect(r.statusCode).toBe(201);
    const emails = await emailsPara(admin);
    expect(emails).toHaveLength(1);
    expect(emails[0].assunto).toContain("Reserva confirmada");
    const [a, m, d] = dia.split("-");
    const [a2, m2, d2] = somarDias(dia, 2).split("-");
    expect(emails[0].corpoHtml).toContain(`${d}/${m}/${a} 08:00 → ${d2}/${m2}/${a2} 17:00`);
  });

  it("Colaborador (modo manual) recebe a confirmação da solicitação", async () => {
    const r = await req(colabA, "POST", "/api/v1/reservas", {
      ...base, plataformaId: plataforma, data: proximoDia(), horaInicio: "08:00", horaFim: "09:00",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("pendente");
    const emails = await emailsPara(colabA);
    expect(emails.map((e) => e.assunto)).toEqual([expect.stringContaining("Solicitação de reserva registrada")]);
    // Aprovadores elegíveis (aqui: o Admin da suíte) recebem o aviso de decisão.
    expect((await emailsPara(admin)).map((e) => e.assunto)).toEqual([expect.stringContaining("aguardando aprovação")]);
  });
});

describe("reserva aprovada", () => {
  it("o solicitante recebe a aprovação feita por outra pessoa", async () => {
    const id = await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabA.id, plataformaId: plataforma, data: proximoDia(), horaInicio: "10:00", horaFim: "11:00", status: "pendente" });
    expect((await req(admin, "POST", `/api/v1/reservas/${id}/aprovar`, {})).statusCode).toBe(200);
    expect((await emailsPara(colabA)).map((e) => e.assunto)).toEqual([expect.stringContaining("Reserva aprovada")]);
  });

  it("recebe também quando o próprio solicitante aprova (comprovante)", async () => {
    const id = await inserirReservaTeste({ setorId: setor.id, solicitanteId: admin.id, plataformaId: plataforma, data: proximoDia(), horaInicio: "10:00", horaFim: "11:00", status: "pendente" });
    expect((await req(admin, "POST", `/api/v1/reservas/${id}/aprovar`, {})).statusCode).toBe(200);
    expect((await emailsPara(admin)).map((e) => e.assunto)).toEqual([expect.stringContaining("Reserva aprovada")]);
  });
});

describe("reserva cancelada", () => {
  it("cancelamento próprio gera confirmação para o responsável", async () => {
    const id = await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabA.id, plataformaId: plataforma, data: proximoDia(), horaInicio: "12:00", horaFim: "13:00", status: "agendada" });
    expect((await req(colabA, "POST", `/api/v1/reservas/${id}/cancelar`)).statusCode).toBe(200);
    const emails = await emailsPara(colabA);
    expect(emails).toHaveLength(1);
    expect(emails[0].corpoHtml).toContain("Você cancelou sua reserva");
  });

  it("cancelamento por outra pessoa avisa o responsável (e não quem cancelou)", async () => {
    const id = await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabA.id, plataformaId: plataforma, data: proximoDia(), horaInicio: "12:00", horaFim: "13:00", status: "agendada" });
    expect((await req(admin, "POST", `/api/v1/reservas/${id}/cancelar`)).statusCode).toBe(200);
    expect((await emailsPara(colabA))[0].corpoHtml).toContain("foi cancelada por outro usuário");
    expect(await emailsPara(admin)).toEqual([]);
  });
});

describe("substituição por reserva urgente", () => {
  it("dono da reserva anterior recebe a substituição; solicitante da urgente, a aprovação", async () => {
    const dia = proximoDia();
    await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabA.id, plataformaId: plataforma, data: dia, horaInicio: "08:00", horaFim: "10:00", status: "agendada" });
    const urgente = await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabB.id, plataformaId: plataforma, data: dia, horaInicio: "09:00", horaFim: "11:00", status: "pendente", prioridade: "urgente" });
    expect((await req(admin, "POST", `/api/v1/reservas/${urgente}/aprovar`, { substituirConflitantes: true })).statusCode).toBe(200);
    expect((await emailsPara(colabA)).map((e) => e.assunto)).toEqual([expect.stringContaining("Reserva substituída")]);
    expect((await emailsPara(colabB)).map((e) => e.assunto)).toEqual([expect.stringContaining("Reserva aprovada")]);
  });

  it("mesma pessoa nas duas reservas recebe UM e-mail, que menciona a substituição", async () => {
    const dia = proximoDia();
    await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabB.id, plataformaId: plataforma, data: dia, horaInicio: "08:00", horaFim: "10:00", status: "agendada" });
    const urgente = await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabB.id, plataformaId: plataforma, data: dia, horaInicio: "09:00", horaFim: "11:00", status: "pendente", prioridade: "urgente" });
    expect((await req(admin, "POST", `/api/v1/reservas/${urgente}/aprovar`, { substituirConflitantes: true })).statusCode).toBe(200);
    const emails = await emailsPara(colabB);
    expect(emails).toHaveLength(1);
    expect(emails[0].assunto).toContain("Reserva aprovada");
    expect(emails[0].corpoHtml).toContain("substituiu sua reserva anterior");
  });
});
