import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../../app.js");
const { closePool, getPool, sql } = await import("../../db/pool.js");
const { invalidarCacheConfiguracao } = await import("../../services/configuracao.service.js");
const { somarDias } = await import("../../services/disponibilidadeDia.service.js");
const {
  criarUsuarioTeste,
  dataFuturaAleatoria,
  definirPoliticaSubstituicao,
  garantirSetor,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

/* Etapas 2–5: setor responsável da plataforma, gestão por criador/setor/responsável direto,
 * área de responsáveis (Admin), política de substituição urgente e auditoria operacional do
 * Gestor. Tudo pela API real; perfis/setores/status lidos do banco a cada requisição. */

const PREFIXOS = { plataforma: "PLT-GESTRESP", email: "teste.gestresp.", bloqueio: "GESTRESP" };

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let manutencao: Setor;
let ti: Setor;
let admin: Usuario;
let gestorManut: Usuario; // criador das plataformas da Manutenção
let gestorManut2: Usuario; // mesmo setor, não criador
let gestorTi: Usuario; // outro setor (vira responsável)
let gestorTi2: Usuario; // outro setor, sem vínculo
let colaborador: Usuario;
// Restaura valor E metadados (última alteração) da política ao fim da suíte.
let restaurarPolitica: () => Promise<void>;

let platManut: string; // setor Manutenção, criada pelo gestorManut
let platTi: string; // setor TI, criada pelo Admin

function req(usuario: Usuario | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as Record<string, unknown>, headers: usuario ? { cookie: usuario.cookie } : {} });
}

const CATEGORIA = "elevatoria";
const corpoPlataforma = (codigo: string, extra: Record<string, unknown> = {}) => ({ codigo, nome: `Plataforma ${codigo}`, categoria: CATEGORIA, ...extra });
const editar = (u: Usuario, id: string, codigo: string, extra: Record<string, unknown> = {}) =>
  req(u, "PUT", `/api/v1/plataformas/${id}`, corpoPlataforma(codigo, extra));
const mudarStatus = (u: Usuario, id: string, status: string) => req(u, "PATCH", `/api/v1/plataformas/${id}/status`, { status });
const enviarImagem = (u: Usuario, id: string) => req(u, "POST", `/api/v1/plataformas/${id}/imagens`, { imagemBase64: "data:image/png;base64,AAAA" });

async function definirPolitica(valor: string) {
  const pool = await getPool();
  await pool.request().input("v", sql.NVarChar, valor).query("UPDATE ConfiguracaoSistema SET valor = @v WHERE chave = 'politica_substituicao_reserva_urgente'");
  invalidarCacheConfiguracao();
}

async function atualizarUsuario(u: Usuario, campos: { perfil?: string; ativo?: boolean; setorId?: string }) {
  const pool = await getPool();
  const r = pool.request().input("id", sql.UniqueIdentifier, u.id);
  const sets: string[] = [];
  if (campos.perfil) { r.input("perfil", sql.VarChar, campos.perfil); sets.push("perfil = @perfil"); }
  if (campos.ativo !== undefined) { r.input("ativo", sql.Bit, campos.ativo); sets.push("ativo = @ativo"); }
  if (campos.setorId) { r.input("setor", sql.UniqueIdentifier, campos.setorId); sets.push("setor_id = @setor"); }
  await r.query(`UPDATE Usuario SET ${sets.join(", ")} WHERE id = @id`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  manutencao = await garantirSetor("Manutenção");
  ti = await garantirSetor("TI");
  const u = (sufixo: string, perfil: "admin" | "gestor_setor" | "colaborador", setorId: string) =>
    criarUsuarioTeste({ email: `${PREFIXOS.email}${sufixo}@metalsider.com.br`, nome: `Teste ${sufixo}`, perfil, setorId });
  admin = await u("admin", "admin", manutencao.id);
  gestorManut = await u("gestor.manut", "gestor_setor", manutencao.id);
  gestorManut2 = await u("gestor.manut2", "gestor_setor", manutencao.id);
  gestorTi = await u("gestor.ti", "gestor_setor", ti.id);
  gestorTi2 = await u("gestor.ti2", "gestor_setor", ti.id);
  colaborador = await u("colab", "colaborador", manutencao.id);
  restaurarPolitica = await definirPoliticaSubstituicao("todos_aprovadores");
});

afterAll(async () => {
  await restaurarPolitica?.();
  const pool = await getPool();
  await pool.request().query(`DELETE FROM PlataformaResponsavel WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo LIKE '${PREFIXOS.plataforma}%')`);
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(manutencao);
  await removerSetorSeCriado(ti);
  await app.close();
  await closePool();
});

describe("setor responsável no cadastro", () => {
  it("Admin precisa escolher o setor; com setor, cria", async () => {
    expect((await req(admin, "POST", "/api/v1/plataformas", corpoPlataforma(`${PREFIXOS.plataforma}-SEM`))).statusCode).toBe(422);
    const r = await req(admin, "POST", "/api/v1/plataformas", corpoPlataforma(`${PREFIXOS.plataforma}-TI`, { setorId: ti.id }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ setorId: expect.any(String), podeEditar: true, origemGestao: "admin" });
    platTi = r.json().id;
  });

  it("Gestor cadastra sempre no próprio setor, ignorando o setor enviado", async () => {
    const r = await req(gestorManut, "POST", "/api/v1/plataformas", corpoPlataforma(`${PREFIXOS.plataforma}-MAN`, { setorId: ti.id }));
    expect(r.statusCode).toBe(201);
    expect(r.json().setorId.toLowerCase()).toBe(manutencao.id.toLowerCase());
    expect(r.json().origemGestao).toBe("criador");
    platManut = r.json().id;
  });

  it("Gestor não altera o setor responsável", async () => {
    expect((await editar(gestorManut, platManut, `${PREFIXOS.plataforma}-MAN`, { setorId: ti.id })).statusCode).toBe(403);
  });

  it("Colaborador não cadastra", async () => {
    expect((await req(colaborador, "POST", "/api/v1/plataformas", corpoPlataforma(`${PREFIXOS.plataforma}-COL`))).statusCode).toBe(403);
  });
});

describe("gestão por criador, setor e responsável direto", () => {
  it("Admin edita qualquer plataforma; criador e gestor do mesmo setor editam", async () => {
    expect((await editar(admin, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
    expect((await editar(gestorManut, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
    expect((await editar(gestorManut2, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
    expect((await mudarStatus(gestorManut2, platManut, "manutencao")).statusCode).toBe(200);
    expect((await mudarStatus(gestorManut2, platManut, "disponivel")).statusCode).toBe(200);
  });

  it("gestor de outro setor sem vínculo e colaborador recebem 403 em todas as rotas de escrita", async () => {
    for (const u of [gestorTi, colaborador]) {
      expect((await editar(u, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
      expect((await mudarStatus(u, platManut, "manutencao")).statusCode).toBe(403);
      expect((await enviarImagem(u, platManut)).statusCode).toBe(403);
    }
  });

  it("Gestor não atribui responsáveis; Admin atribui e só aceita Gestor ativo", async () => {
    expect((await req(gestorManut, "POST", `/api/v1/plataformas/${platManut}/responsaveis`, { gestorIds: [gestorTi.id] })).statusCode).toBe(403);
    expect((await req(admin, "POST", `/api/v1/plataformas/${platManut}/responsaveis`, { gestorIds: [colaborador.id] })).statusCode).toBe(422);
    const r = await req(admin, "POST", `/api/v1/plataformas/${platManut}/responsaveis`, { gestorIds: [gestorTi.id] });
    expect(r.statusCode).toBe(200);
    expect(r.json().responsaveis.map((x: { gestorId: string }) => x.gestorId.toLowerCase())).toEqual([gestorTi.id.toLowerCase()]);
  });

  it("responsável de outro setor gerencia (dados, status e imagens passam pela permissão)", async () => {
    expect((await editar(gestorTi, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
    expect((await mudarStatus(gestorTi, platManut, "disponivel")).statusCode).toBe(200);
    // 422 = passou da permissão e parou na validação do arquivo.
    expect((await enviarImagem(gestorTi, platManut)).statusCode).toBe(422);
    const lista = (await req(gestorTi, "GET", "/api/v1/plataformas")).json() as Array<{ id: string; podeEditar: boolean; origemGestao: string | null }>;
    expect(lista.find((p) => p.id === platManut)).toMatchObject({ podeEditar: true, origemGestao: "responsavel" });
    expect(lista.find((p) => p.id === platTi)).toMatchObject({ podeEditar: true, origemGestao: "setor" });
    expect((await editar(gestorTi2, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
  });

  it("responsável desativado perde a sessão; rebaixado perde a gestão; reativado volta", async () => {
    await atualizarUsuario(gestorTi, { ativo: false });
    expect((await editar(gestorTi, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(401);
    await atualizarUsuario(gestorTi, { ativo: true, perfil: "colaborador" });
    expect((await editar(gestorTi, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
    await atualizarUsuario(gestorTi, { perfil: "gestor_setor" });
    expect((await editar(gestorTi, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
  });

  it("troca de setor do gestor vale na hora", async () => {
    expect((await editar(gestorTi2, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
    await atualizarUsuario(gestorTi2, { setorId: manutencao.id });
    expect((await editar(gestorTi2, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(200);
    await atualizarUsuario(gestorTi2, { setorId: ti.id });
    expect((await editar(gestorTi2, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
  });

  it("remover a responsabilidade retira a gestão e fica auditado com antes/depois", async () => {
    const r = await req(admin, "DELETE", `/api/v1/plataformas/${platManut}/responsaveis/${gestorTi.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().responsaveis).toEqual([]);
    expect((await editar(gestorTi, platManut, `${PREFIXOS.plataforma}-MAN`)).statusCode).toBe(403);
    const pool = await getPool();
    const log = await pool.request().input("p", sql.UniqueIdentifier, platManut).query(
      "SELECT acao, detalhes FROM LogAuditoria WHERE entidade_id = @p AND acao IN ('atribuir_responsaveis_plataforma','remover_responsavel_plataforma') ORDER BY criado_em"
    );
    expect(log.recordset.map((l: { acao: string }) => l.acao)).toEqual(["atribuir_responsaveis_plataforma", "remover_responsavel_plataforma"]);
    const remocao = JSON.parse(log.recordset[1].detalhes);
    expect(remocao.responsaveisAnteriores).toHaveLength(1);
    expect(remocao.responsaveisNovos).toHaveLength(0);
  });
});

describe("política de substituição por reserva urgente", () => {
  // Um dia DIFERENTE por cenário, a partir de uma base sorteada uma vez: dias sorteados de
  // forma independente podiam coincidir e a urgente aprovada no cenário anterior virava um
  // conflito urgente no seguinte ("urgência não substitui urgência" → 409 intermitente).
  const diaBase = dataFuturaAleatoria();
  let dia: string;
  let n = 0;

  /** Agendada 08–10 e urgente pendente 09–11 na plataforma da TI (a cada chamada, um dia novo). */
  async function cenario(emUso = false) {
    n += 1;
    dia = somarDias(diaBase, n);
    const atual = await inserirReservaTeste({
      setorId: ti.id, solicitanteId: colaborador.id, plataformaId: platTi, data: dia,
      horaInicio: "08:00", horaFim: "10:00", status: emUso ? "em_uso" : "agendada", motivo: `atual ${n}`,
    });
    const urgente = await inserirReservaTeste({
      setorId: manutencao.id, solicitanteId: colaborador.id, plataformaId: platTi, data: dia,
      horaInicio: "09:00", horaFim: "11:00", status: "pendente", prioridade: "urgente", motivo: `urgente ${n}`,
    });
    return { atual, urgente };
  }
  const aprovar = (u: Usuario, id: string, corpo: Record<string, unknown>) => req(u, "POST", `/api/v1/reservas/${id}/aprovar`, corpo);

  it("todos_aprovadores (padrão): gestor sem vínculo autoriza", async () => {
    await definirPolitica("todos_aprovadores");
    const { urgente } = await cenario();
    const analise = (await req(gestorManut2, "GET", `/api/v1/reservas/${urgente}/analise-aprovacao`)).json();
    expect(analise.autorizacaoSubstituicao).toMatchObject({ permitido: true, politica: "todos_aprovadores" });
    expect((await aprovar(gestorManut2, urgente, { substituirConflitantes: true })).statusCode).toBe(200);
  });

  it("restrita: sem responsável, só o Admin; gestor recebe 403 e a tentativa é auditada", async () => {
    await definirPolitica("responsaveis_plataforma_ou_admin");
    const { urgente, atual } = await cenario();
    const analise = (await req(gestorTi, "GET", `/api/v1/reservas/${urgente}/analise-aprovacao`)).json();
    expect(analise.podeSubstituir).toBe(false);
    expect(analise.autorizacaoSubstituicao.motivo).toContain("não tem gestor responsável");
    const negado = await aprovar(gestorTi, urgente, { substituirConflitantes: true });
    expect(negado.statusCode).toBe(403);
    const pool = await getPool();
    const st = async (id: string) => (await pool.request().input("id", sql.UniqueIdentifier, id).query("SELECT status FROM Reserva WHERE id = @id")).recordset[0].status;
    expect(await st(atual)).toBe("agendada");
    expect(await st(urgente)).toBe("pendente");
    const recusa = await pool.request().input("id", sql.UniqueIdentifier, urgente).query("SELECT detalhes FROM LogAuditoria WHERE entidade_id = @id AND acao = 'substituicao_urgente_recusada'");
    expect(JSON.parse(recusa.recordset[0].detalhes).politica).toBe("responsaveis_plataforma_ou_admin");
    const ok = await aprovar(admin, urgente, { substituirConflitantes: true });
    expect(ok.statusCode).toBe(200);
    const auditoria = await pool.request().input("id", sql.UniqueIdentifier, atual).query("SELECT detalhes FROM LogAuditoria WHERE entidade_id = @id AND acao = 'substituir_reserva'");
    expect(JSON.parse(auditoria.recordset[0].detalhes)).toMatchObject({ politicaSubstituicao: "responsaveis_plataforma_ou_admin", regraAutorizacao: "admin" });
  });

  it("restrita: responsável direto autoriza; gestor do mesmo setor da plataforma, não", async () => {
    await req(admin, "POST", `/api/v1/plataformas/${platTi}/responsaveis`, { gestorIds: [gestorManut.id] });
    const { urgente } = await cenario();
    expect((await aprovar(gestorTi, urgente, { substituirConflitantes: true })).statusCode).toBe(403);
    const ok = await aprovar(gestorManut, urgente, { substituirConflitantes: true });
    expect(ok.statusCode).toBe(200);
  });

  it("interromper reserva EM USO continua exigindo a segunda confirmação", async () => {
    const { urgente } = await cenario(true);
    const sem = await aprovar(gestorManut, urgente, { substituirConflitantes: true });
    expect(sem.statusCode).toBe(409);
    expect(sem.json().codigo).toBe("CONFIRMAR_INTERRUPCAO_EM_USO");
    expect((await aprovar(gestorManut, urgente, { substituirConflitantes: true, confirmarInterrupcaoEmUso: true })).statusCode).toBe(200);
  });

  it("concorrência: duas confirmações simultâneas resultam em uma substituição só", async () => {
    const { urgente, atual } = await cenario();
    const respostas = await Promise.all([
      aprovar(admin, urgente, { substituirConflitantes: true }),
      aprovar(gestorManut, urgente, { substituirConflitantes: true }),
    ]);
    expect(respostas.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const pool = await getPool();
    const subs = await pool.request().input("id", sql.UniqueIdentifier, atual).query("SELECT COUNT(*) AS n FROM LogAuditoria WHERE entidade_id = @id AND acao = 'substituir_reserva'");
    expect(subs.recordset[0].n).toBe(1);
  });

  it("mudar a política por Configurações fica auditado", async () => {
    await definirPolitica("todos_aprovadores");
    const r = await req(admin, "PUT", "/api/v1/configuracoes", { politicaSubstituicaoReservaUrgente: "responsaveis_plataforma_ou_admin" });
    expect(r.statusCode).toBe(200);
    const pool = await getPool();
    const log = await pool.request().input("u", sql.UniqueIdentifier, admin.id).query(
      "SELECT detalhes FROM LogAuditoria WHERE usuario_id = @u AND acao = 'alterar_politica_substituicao_urgente'"
    );
    expect(JSON.parse(log.recordset[0].detalhes)).toEqual({ politicaAnterior: "todos_aprovadores", politicaNova: "responsaveis_plataforma_ou_admin" });
  });
});

describe("auditoria operacional do Gestor", () => {
  type Registro = { acao: string; entidade: string; entidadeId: string | null; usuarioId: string | null; detalhes: unknown };
  const listar = async (u: Usuario, q = "") => {
    const r = await req(u, "GET", `/api/v1/auditoria?limit=200${q}`);
    return { status: r.statusCode, escopo: r.headers["x-escopo-auditoria"], registros: (r.statusCode === 200 ? r.json() : []) as Registro[] };
  };

  it("Admin vê tudo, inclusive configurações e responsáveis", async () => {
    const { registros, escopo } = await listar(admin, "&categoria=Configura%C3%A7%C3%B5es");
    expect(escopo).toBe("completo");
    expect(registros.some((r) => r.acao === "alterar_politica_substituicao_urgente")).toBe(true);
  });

  it("Gestor vê reservas do próprio setor e plataformas sob sua responsabilidade fora do setor", async () => {
    const { registros, escopo } = await listar(gestorManut);
    expect(escopo).toBe("operacional");
    // platTi é da TI, mas gestorManut é responsável por ela.
    expect(registros.some((r) => r.entidade === "Plataforma" && r.entidadeId?.toLowerCase() === platTi.toLowerCase())).toBe(true);
    expect(registros.every((r) => !["alterar_politica_substituicao_urgente", "atribuir_responsaveis_plataforma", "remover_responsavel_plataforma"].includes(r.acao))).toBe(true);
    expect(registros.every((r) => ["Reserva", "Plataforma", "Comentario", "Anexo", "Ocorrencia", "NaoConformidade", "ChecklistPreenchido"].includes(r.entidade))).toBe(true);
  });

  it("Gestor sem vínculo não vê a plataforma de outro setor, e filtros não alargam o escopo", async () => {
    const { registros } = await listar(gestorTi2, `&usuarioId=${admin.id}`);
    // gestorTi2 é da TI: platTi (TI) entra pelo setor; platManut (Manutenção), não.
    expect(registros.some((r) => r.entidadeId?.toLowerCase() === platManut.toLowerCase())).toBe(false);
    const config = await listar(gestorTi2, "&categoria=Configura%C3%A7%C3%B5es");
    expect(config.registros).toEqual([]);
  });

  it("payload sem campos sensíveis e exportação bloqueada para o Gestor", async () => {
    const { registros } = await listar(gestorManut);
    expect(JSON.stringify(registros.map((r) => r.detalhes))).not.toMatch(/"e-?mail[^"]*":/i);
    expect((await req(gestorManut, "GET", "/api/v1/auditoria/export")).statusCode).toBe(403);
    expect((await req(colaborador, "GET", "/api/v1/auditoria")).statusCode).toBe(403);
  });
});
