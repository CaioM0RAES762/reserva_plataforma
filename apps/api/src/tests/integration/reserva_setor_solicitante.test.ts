import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../../app.js");
const { closePool } = await import("../../db/pool.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* "Setor solicitante" da Nova Reserva: o setor do usuário é só o PADRÃO — quem solicita pode
 * reservar para outro setor ativo. O bug: um Admin COM setor na sessão (ex.: Caio · TI) via o
 * formulário sem o seletor, o setorId não era enviado e a API respondia "Selecione o setor
 * para o qual a reserva está sendo solicitada." */

const PREFIXOS = { plataforma: "PLT-SETSOL", email: "teste.setsol.", bloqueio: "SETSOL" };
const DIA = dataFuturaAleatoria();

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let ti: Setor;
let manutencao: Setor;
let adminComSetor: Usuario;
let adminSemSetor: Usuario;
let colaboradorTi: Usuario;
let plataformaId: string;

function corpo(horaInicio: string, horaFim: string, extra: Record<string, unknown> = {}) {
  return {
    plataformaId,
    data: DIA,
    horaInicio,
    horaFim,
    quantidadePessoas: 1,
    motivo: "Teste de setor solicitante",
    telefoneContato: "(11) 91234-5678",
    ...extra,
  };
}

function criar(usuario: Usuario, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/reservas", headers: { cookie: usuario.cookie }, payload });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  ti = await garantirSetor("TI");
  manutencao = await garantirSetor("Manutenção");
  adminComSetor = await criarUsuarioTeste({ email: `${PREFIXOS.email}admin.ti@metalsider.com.br`, nome: "Admin TI (setsol)", perfil: "admin", setorId: ti.id });
  adminSemSetor = await criarUsuarioTeste({ email: `${PREFIXOS.email}admin@metalsider.com.br`, nome: "Admin (setsol)", perfil: "admin", setorId: null });
  colaboradorTi = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab.ti@metalsider.com.br`, nome: "Colab TI (setsol)", perfil: "colaborador", setorId: ti.id });
  plataformaId = await criarPlataformaTeste({ codigo: "PLT-SETSOL-1", nome: "Plataforma teste setor solicitante" });
});

afterAll(async () => {
  await limparResiduos(PREFIXOS);
  for (const setor of [ti, manutencao]) await removerSetorSeCriado(setor);
  await app.close();
  await closePool();
});

describe("Setor solicitante da reserva", () => {
  it("Admin com setor (Caio · TI) enviando o setor padrão cria a reserva — sem o 422 do bug", async () => {
    const r = await criar(adminComSetor, corpo("08:00", "09:00", { setorId: ti.id }));
    expect(r.statusCode).toBe(201);
    expect(r.json().setorId.toLowerCase()).toBe(ti.id.toLowerCase());
  });

  it("usuário de TI trocando para Manutenção: a reserva é salva com Manutenção", async () => {
    for (const [usuario, inicio, fim] of [
      [adminComSetor, "09:00", "10:00"],
      [colaboradorTi, "10:00", "11:00"],
    ] as const) {
      const r = await criar(usuario, corpo(inicio, fim, { setorId: manutencao.id }));
      expect(r.statusCode).toBe(201);
      expect(r.json().setorId.toLowerCase()).toBe(manutencao.id.toLowerCase());
    }
  });

  it("sem setorId no corpo vale o setor da sessão", async () => {
    const r = await criar(colaboradorTi, corpo("11:00", "12:00"));
    expect(r.statusCode).toBe(201);
    expect(r.json().setorId.toLowerCase()).toBe(ti.id.toLowerCase());
  });

  it("'Selecione o setor…' só quando realmente não há setor (Admin sem setor e sem seleção)", async () => {
    const r = await criar(adminSemSetor, corpo("12:00", "13:00"));
    expect(r.statusCode).toBe(422);
    expect(r.json().erro).toBe("Selecione o setor para o qual a reserva está sendo solicitada.");
  });

  it("setor inexistente é recusado (validação de setor existente preservada)", async () => {
    const r = await criar(colaboradorTi, corpo("13:00", "14:00", { setorId: "00000000-0000-0000-0000-000000000000" }));
    expect(r.statusCode).toBe(422);
    expect(r.json().erro).toBe("Setor solicitante inválido ou inativo.");
  });
});
