import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../../app.js");
const { closePool } = await import("../../db/pool.js");
const { agoraEmBrasilia } = await import("../../services/automacaoReserva.service.js");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* Escopo de dados (regra do produto):
 *  - OPERACIONAL compartilhado (Agenda em curso, disponibilidade): global para todo perfil;
 *  - PESSOAL ("Minhas próximas reservas"): só do próprio usuário;
 *  - GERENCIAL (Relatórios): global para Admin e Gestor, filtro de setor só explícito;
 *    Colaborador continua sem acesso. */

const PREFIXOS = { plataforma: "PLT-ESC-OPS", email: "teste.esc.ops.", bloqueio: "ESC-OPS" };
const HOJE = agoraEmBrasilia().data;
const DIA_RELATORIO = dataFuturaAleatoria();

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let manutencao: Setor;
let ti: Setor;
let seguranca: Setor;
let almoxarifado: Setor;
let admin: Usuario;
let gestorTi: Usuario;
let colabAlmox: Usuario;
let colabManut: Usuario;
let plataformaId: string;
const reservasHoje: string[] = [];
let minhaProxima: string;
let proximaAlheia: string;

function get(usuario: Usuario, url: string) {
  return app.inject({ method: "GET", url, headers: { cookie: usuario.cookie } });
}

const ids = (lista: Array<{ id: string }>) => lista.map((r) => r.id.toLowerCase());

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);

  manutencao = await garantirSetor("Manutenção");
  ti = await garantirSetor("TI");
  seguranca = await garantirSetor("Segurança");
  almoxarifado = await garantirSetor("Almoxarifado");

  admin = await criarUsuarioTeste({ email: `${PREFIXOS.email}admin@metalsider.com.br`, nome: "Admin (escopo)", perfil: "admin", setorId: null });
  gestorTi = await criarUsuarioTeste({ email: `${PREFIXOS.email}gestor.ti@metalsider.com.br`, nome: "Gestor TI (escopo)", perfil: "gestor_setor", setorId: ti.id });
  colabAlmox = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab.almox@metalsider.com.br`, nome: "Colab Almox (escopo)", perfil: "colaborador", setorId: almoxarifado.id });
  colabManut = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab.manut@metalsider.com.br`, nome: "Colab Manut (escopo)", perfil: "colaborador", setorId: manutencao.id });
  plataformaId = await criarPlataformaTeste({ codigo: "PLT-ESC-OPS-1", nome: "Plataforma teste escopo" });

  // Reservas A/B/C de HOJE, de três setores diferentes (nenhum deles o Almoxarifado).
  for (const [setor, inicio, fim] of [
    [manutencao, "01:00", "02:00"],
    [ti, "02:00", "03:00"],
    [seguranca, "03:00", "04:00"],
  ] as const) {
    reservasHoje.push(
      await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabManut.id, plataformaId, data: HOJE, horaInicio: inicio, horaFim: fim, status: "agendada" })
    );
  }

  // Próximos dias: uma do colaborador do Almoxarifado e uma alheia.
  minhaProxima = await inserirReservaTeste({ setorId: almoxarifado.id, solicitanteId: colabAlmox.id, plataformaId, data: somarDias(HOJE, 2), horaInicio: "08:00", horaFim: "09:00", status: "agendada" });
  proximaAlheia = await inserirReservaTeste({ setorId: manutencao.id, solicitanteId: colabManut.id, plataformaId, data: somarDias(HOJE, 2), horaInicio: "10:00", horaFim: "11:00", status: "agendada" });

  // Relatório: 1h de cada setor numa data futura isolada (sem colisão com o cache de relatório).
  for (const [setor, inicio, fim] of [
    [manutencao, "08:00", "09:00"],
    [ti, "09:00", "10:00"],
    [seguranca, "10:00", "11:00"],
  ] as const) {
    await inserirReservaTeste({ setorId: setor.id, solicitanteId: colabManut.id, plataformaId, data: DIA_RELATORIO, horaInicio: inicio, horaFim: fim, status: "agendada" });
  }
});

afterAll(async () => {
  await limparResiduos(PREFIXOS);
  for (const setor of [manutencao, ti, seguranca, almoxarifado]) await removerSetorSeCriado(setor);
  await app.close();
  await closePool();
});

describe("Central de Operações — Agenda em curso é global", () => {
  it.each([
    ["Admin", () => admin],
    ["Gestor de TI", () => gestorTi],
    ["Colaborador do Almoxarifado", () => colabAlmox],
  ])("%s vê as reservas de hoje de Manutenção, TI e Segurança", async (_perfil, usuario) => {
    const response = await get(usuario(), "/api/v1/dashboard/agenda");
    expect(response.statusCode).toBe(200);
    const hoje = ids(response.json().hoje);
    for (const id of reservasHoje) expect(hoje).toContain(id.toLowerCase());
  });

  it("KPI de reservas de hoje é o mesmo para qualquer perfil", async () => {
    const [a, g, c] = await Promise.all([admin, gestorTi, colabAlmox].map((u) => get(u, "/api/v1/dashboard/kpis")));
    expect(g.json().reservasHoje).toBe(a.json().reservasHoje);
    expect(c.json().reservasHoje).toBe(a.json().reservasHoje);
  });
});

describe("Minhas próximas reservas — continua pessoal", () => {
  it("o colaborador vê a própria reserva e não a alheia", async () => {
    const response = await get(colabAlmox, "/api/v1/dashboard/agenda");
    const proximas = ids(response.json().proximas);
    expect(proximas).toContain(minhaProxima.toLowerCase());
    expect(proximas).not.toContain(proximaAlheia.toLowerCase());
  });
});

describe("Relatórios — Gestor tem visão global", () => {
  const periodo = `dateFrom=${DIA_RELATORIO}&dateTo=${DIA_RELATORIO}&plataforma=`;
  const horasDaPlataforma = (corpo: { plataformas: Array<{ plataformaId: string; horasReservadas: number }> }) =>
    corpo.plataformas.find((p) => p.plataformaId.toLowerCase() === plataformaId.toLowerCase())?.horasReservadas;

  it("Gestor de TI, sem filtro: todos os setores (3h, não só a 1h da TI)", async () => {
    const response = await get(gestorTi, `/api/v1/relatorios/utilizacao?${periodo}${plataformaId}`);
    expect(response.statusCode).toBe(200);
    expect(horasDaPlataforma(response.json())).toBe(3);
  });

  it("Gestor de TI filtrando Manutenção: o filtro explícito vale (1h)", async () => {
    const response = await get(gestorTi, `/api/v1/relatorios/utilizacao?${periodo}${plataformaId}&setor=${manutencao.id}`);
    expect(response.statusCode).toBe(200);
    expect(horasDaPlataforma(response.json())).toBe(1);
  });

  it("Gestor acessa o ranking por setor (antes era só Admin)", async () => {
    const response = await get(gestorTi, `/api/v1/relatorios/ranking-setores?dateFrom=${DIA_RELATORIO}&dateTo=${DIA_RELATORIO}`);
    expect(response.statusCode).toBe(200);
    const setores = response.json().setores as Array<{ setorId: string; totalReservas: number }>;
    const manut = setores.find((s) => s.setorId.toLowerCase() === manutencao.id.toLowerCase());
    expect(manut?.totalReservas).toBeGreaterThanOrEqual(1);
  });

  it("Colaborador continua sem acesso aos relatórios (regra atual preservada)", async () => {
    const response = await get(colabAlmox, `/api/v1/relatorios/utilizacao?dateFrom=${DIA_RELATORIO}&dateTo=${DIA_RELATORIO}`);
    expect(response.statusCode).toBe(403);
  });

  it("Gestor continua sem acesso às Configurações administrativas", async () => {
    const response = await get(gestorTi, "/api/v1/configuracoes");
    expect(response.statusCode).toBe(403);
  });
});
