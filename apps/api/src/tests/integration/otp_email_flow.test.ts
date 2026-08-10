import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";
import { definirProviderEmailParaTeste } from "../../services/email.service.js";
import { limparLockEmissaoParaTeste } from "../../services/otp.service.js";
import { getRedis } from "../../db/redis.js";
import {
  criarProviderMockSempreAceita,
  criarProviderMockSempreRejeita,
  MockEmailProvider,
} from "../helpers/emailProviderMock.js";

// `app.inject()` sem `remoteAddress` explícito usa sempre o mesmo IP de loopback — outros
// arquivos de teste (não relacionados a e-mail) rodando na mesma janela de 10min
// consomem a MESMA cota do rate limit por IP (rateLimit.ts) e derrubavam estes testes por
// um motivo que nada tem a ver com a lógica sendo testada aqui. Um IP dedicado (faixa
// TEST-NET-2, reservada para documentação/teste, RFC 5737 — nunca roteável de verdade)
// isola este arquivo de qualquer outro.
const IP_DEDICADO_DESTE_ARQUIVO = "198.51.100.7";

function injetar(opts: InjectOptions) {
  return app.inject({ remoteAddress: IP_DEDICADO_DESTE_ARQUIVO, ...opts });
}

// Cobre exatamente os 3 fluxos reais descritos pelo usuário (criação de conta pelo Admin,
// reenvio, recuperação de senha) pelos ENDPOINTS HTTP reais que o frontend chama — não
// chamando funções internas diretamente. O provedor de e-mail é um mock (sem rede real),
// mas toda a lógica de negócio (rate limit, transação, lock de concorrência, purpose do
// código) roda de verdade.

const EMAIL_ADMIN_CRIA = "teste.otp.admin.cria@metalsider.com.br";
const EMAIL_ADMIN_FALHA = "teste.otp.admin.falha@metalsider.com.br";
const EMAIL_REENVIO = "teste.otp.reenvio@metalsider.com.br";
const EMAIL_CONCORRENCIA = "teste.otp.concorrencia@metalsider.com.br";
const EMAIL_RESET = "teste.otp.reset@metalsider.com.br";
const EMAIL_AUTOCADASTRO = "teste.otp.autocadastro@metalsider.com.br";
const EMAIL_AUTOCADASTRO_PENDENTE = "teste.otp.autocadastro.pendente@metalsider.com.br";
const EMAIL_AUTOCADASTRO_ATIVO = "teste.otp.autocadastro.ativo@metalsider.com.br";
// Admin próprio deste arquivo, criado direto via SQL — não depende de SEED_ADMIN_EMAIL/
// SEED_ADMIN_PASSWORD (variáveis de ambiente que podem não estar definidas; este arquivo
// precisa funcionar de forma autocontida, igual ao padrão já usado em rbac.test.ts para
// criar seus próprios usuários de teste).
const EMAIL_ADMIN_TESTE = "teste.otp.admin.autenticacao@metalsider.com.br";
const SENHA_ADMIN_TESTE = "SenhaAdminTeste123";
const TODOS_EMAILS = [
  EMAIL_ADMIN_CRIA,
  EMAIL_ADMIN_FALHA,
  EMAIL_REENVIO,
  EMAIL_CONCORRENCIA,
  EMAIL_RESET,
  EMAIL_AUTOCADASTRO,
  EMAIL_AUTOCADASTRO_PENDENTE,
  EMAIL_AUTOCADASTRO_ATIVO,
  EMAIL_ADMIN_TESTE,
];

let app: FastifyInstance;
let setorTiId: string;
let cookieAdmin: string;
const idsCriados: string[] = [];

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

function extrairCodigoDoTexto(texto: string): string {
  const match = texto.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`Não achei um código de 6 dígitos no corpo do e-mail: ${texto}`);
  return match[1];
}

async function limparUsuariosDeTeste(): Promise<void> {
  const pool = await getPool();
  const emails = TODOS_EMAILS.map((e) => `'${e}'`).join(",");
  // Notificacao entra aqui por defensividade: nenhum teste deste arquivo gera notificação
  // hoje, mas se uma rodada anterior tiver deixado uma linha órfã (afterAll interrompido no
  // meio), o DELETE de Usuario abaixo falharia com erro de FK sem isto.
  await pool.request().query(`DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${emails}))`);
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${emails}))
        OR entidade_id IN (SELECT id FROM Usuario WHERE email IN (${emails}))`
  );
  await pool.request().query(
    `DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email IN (${emails}))`
  );
  await pool.request().query(`DELETE FROM Usuario WHERE email IN (${emails})`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparUsuariosDeTeste();
  await getRedis().del(`ratelimit:solicitacao-ip:${IP_DEDICADO_DESTE_ARQUIVO}`);

  const pool = await getPool();
  const setor = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setor.recordset[0].id;

  const senhaAdminHash = await hashPassword(SENHA_ADMIN_TESTE);
  await pool
    .request()
    .input("nome", sql.NVarChar, "Admin de Teste (otp_email_flow)")
    .input("email", sql.NVarChar, EMAIL_ADMIN_TESTE)
    .input("senha_hash", sql.VarChar, senhaAdminHash)
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       VALUES (@nome, @email, @senha_hash, 'admin', NULL, 1, 1)`
    );

  const loginAdmin = await injetar({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_ADMIN_TESTE, senha: SENHA_ADMIN_TESTE },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));
});

beforeEach(() => {
  definirProviderEmailParaTeste(null);
});

afterAll(async () => {
  definirProviderEmailParaTeste(null);
  await limparUsuariosDeTeste();
  await app.close();
  await closePool();
});

describe("Fluxo A — Admin cria conta: código deve ser enviado de verdade, não fingido", () => {
  it("provedor aceita: conta criada, e-mail enviado, código no e-mail ativa a conta de verdade", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    const criar = await injetar({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: { nome: "Teste OTP Admin Cria", email: EMAIL_ADMIN_CRIA, perfil: "colaborador", setorId: setorTiId },
    });
    expect(criar.statusCode).toBe(201);
    const usuario = criar.json();
    expect(usuario.codigoEnviado).toBe(true);
    expect(usuario.avisoEnvio).toBeUndefined();
    idsCriados.push(usuario.id);

    // Exatamente um e-mail foi realmente "enviado" (não zero, não dois).
    expect(mock.mensagensEnviadas).toHaveLength(1);
    expect(mock.mensagensEnviadas[0].to).toBe(EMAIL_ADMIN_CRIA);
    expect(mock.mensagensEnviadas[0].subject).toMatch(/Ativação de conta/);

    // O código extraído do CORPO DO E-MAIL (exatamente o que o usuário veria no Outlook)
    // precisa ser o mesmo que ativa a conta de verdade — prova a cadeia completa OTP →
    // template → envio → validação, não só "um e-mail saiu".
    const codigo = extrairCodigoDoTexto(mock.mensagensEnviadas[0].text);
    const ativar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_ADMIN_CRIA, codigo, senha: "SenhaForte123" },
    });
    expect(ativar.statusCode).toBe(200);
  });

  it("provedor rejeita: conta é criada (não é destruída por falha transitória de e-mail), mas a resposta NÃO finge sucesso no envio", async () => {
    definirProviderEmailParaTeste(criarProviderMockSempreRejeita());

    const criar = await injetar({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: { nome: "Teste OTP Admin Falha", email: EMAIL_ADMIN_FALHA, perfil: "colaborador", setorId: setorTiId },
    });
    expect(criar.statusCode).toBe(201);
    const usuario = criar.json();
    idsCriados.push(usuario.id);

    // Este é o teste que teria falhado no comportamento antigo (`enfileirarEmail`
    // fire-and-forget): a rota respondia sucesso sem nunca saber se o envio funcionou.
    expect(usuario.codigoEnviado).toBe(false);
    expect(usuario.avisoEnvio).toMatch(/não foi possível enviar/i);

    // Mesmo com o e-mail falhando, o código FOI persistido no banco (o Admin pode
    // recuperar a situação clicando em "Reenviar código" sem recriar a conta).
    const pool = await getPool();
    const codigos = await pool
      .request()
      .input("id", sql.UniqueIdentifier, usuario.id)
      .query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM CodigoVerificacao WHERE usuario_id = @id AND tipo = 'ativacao_conta'"
      );
    expect(codigos.recordset[0].total).toBe(1);
  });
});

describe("Fluxo B — Reenvio", () => {
  let usuarioId: string;

  beforeAll(async () => {
    definirProviderEmailParaTeste(criarProviderMockSempreAceita());
    const criar = await injetar({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: { nome: "Teste OTP Reenvio", email: EMAIL_REENVIO, perfil: "colaborador", setorId: setorTiId },
    });
    usuarioId = criar.json().id;
    idsCriados.push(usuarioId);
    // A criação acima já emitiu e "enviou" o primeiro código, segurando a trava de
    // cooldown de 30s (otp.service.ts) para este (usuário, tipo). Os testes abaixo
    // exercitam reenvios independentes, não a interação com esse cooldown — isso já tem
    // teste dedicado em "Fluxo B.2 — Concorrência".
    await limparLockEmissaoParaTeste(usuarioId, "ativacao_conta");
  });

  it("reenvio pelo próprio usuário (tela de ativação): provedor rejeitando retorna 502, não 200 mentiroso", async () => {
    definirProviderEmailParaTeste(criarProviderMockSempreRejeita());

    const reenviar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta/reenviar",
      payload: { email: EMAIL_REENVIO },
    });
    expect(reenviar.statusCode).toBe(502);
  });

  it("reenvio pelo próprio usuário: sucesso invalida o código anterior e envia um novo que funciona", async () => {
    const pool = await getPool();
    const antes = await pool
      .request()
      .input("id", sql.UniqueIdentifier, usuarioId)
      .query<{ codigo: string; utilizado: boolean }>(
        "SELECT TOP 1 codigo, utilizado FROM CodigoVerificacao WHERE usuario_id = @id AND tipo = 'ativacao_conta' ORDER BY criado_em DESC"
      );
    const codigoAnterior = antes.recordset[0].codigo;

    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);
    const reenviar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta/reenviar",
      payload: { email: EMAIL_REENVIO },
    });
    expect(reenviar.statusCode).toBe(200);
    expect(mock.mensagensEnviadas).toHaveLength(1);

    // Código anterior foi invalidado — usá-lo agora deve falhar.
    const usarAntigo = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_REENVIO, codigo: codigoAnterior, senha: "SenhaForte123" },
    });
    expect(usarAntigo.statusCode).toBe(400);

    // Código novo (extraído do e-mail "recebido") funciona.
    const codigoNovo = extrairCodigoDoTexto(mock.mensagensEnviadas[0].text);
    const ativar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_REENVIO, codigo: codigoNovo, senha: "SenhaForte123" },
    });
    expect(ativar.statusCode).toBe(200);
  });
});

describe("Fluxo B.2 — Concorrência: cliques duplicados no Reenviar código", () => {
  let usuarioId: string;

  beforeAll(async () => {
    definirProviderEmailParaTeste(criarProviderMockSempreAceita());
    const criar = await injetar({
      method: "POST",
      url: "/api/v1/usuarios",
      headers: { cookie: cookieAdmin },
      payload: { nome: "Teste OTP Concorrencia", email: EMAIL_CONCORRENCIA, perfil: "colaborador", setorId: setorTiId },
    });
    usuarioId = criar.json().id;
    idsCriados.push(usuarioId);
    // Libera a trava da criação para que as duas chamadas concorrentes do teste abaixo
    // disputem a trava ENTRE SI (o que o teste quer provar), não contra o cooldown que
    // sobrou da criação do usuário.
    await limparLockEmissaoParaTeste(usuarioId, "ativacao_conta");
  });

  it("duas solicitações quase simultâneas resultam em UM único e-mail enviado, não dois códigos concorrentes", async () => {
    const mock = new MockEmailProvider("aceitar");
    definirProviderEmailParaTeste(mock);

    const [primeira, segunda] = await Promise.all([
      injetar({ method: "POST", url: "/api/v1/auth/ativar-conta/reenviar", payload: { email: EMAIL_CONCORRENCIA } }),
      injetar({ method: "POST", url: "/api/v1/auth/ativar-conta/reenviar", payload: { email: EMAIL_CONCORRENCIA } }),
    ]);

    // Do ponto de vista do cliente, as duas parecem "sucesso" (não pode revelar qual delas
    // foi coalescida pelo lock) — mas só uma mensagem real foi enviada.
    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(200);
    expect(mock.mensagensEnviadas.length).toBe(1);
  });
});

describe("Fluxo C — Recuperação de senha", () => {
  const senhaOriginal = "SenhaForte123";
  const senhaNova = "NovaSenhaForte456";

  beforeAll(async () => {
    const pool = await getPool();
    const senhaHash = await hashPassword(senhaOriginal);
    const inserir = await pool
      .request()
      .input("nome", sql.NVarChar, "Teste OTP Reset")
      .input("email", sql.NVarChar, EMAIL_RESET)
      .input("senha_hash", sql.VarChar, senhaHash)
      .input("setor_id", sql.UniqueIdentifier, setorTiId)
      .query<{ id: string }>(
        `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
         OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
      );
    idsCriados.push(inserir.recordset[0].id);
  });

  it("solicitar → e-mail com template de redefinição → confirmar → login com a nova senha funciona", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    const solicitar = await injetar({
      method: "POST",
      url: "/api/v1/auth/recuperar-senha",
      payload: { email: EMAIL_RESET },
    });
    expect(solicitar.statusCode).toBe(200);
    expect(mock.mensagensEnviadas).toHaveLength(1);
    expect(mock.mensagensEnviadas[0].subject).toMatch(/Redefinição de senha/);

    const codigo = extrairCodigoDoTexto(mock.mensagensEnviadas[0].text);
    const confirmar = await injetar({
      method: "POST",
      url: "/api/v1/auth/recuperar-senha/confirmar",
      payload: { email: EMAIL_RESET, codigo, novaSenha: senhaNova },
    });
    expect(confirmar.statusCode).toBe(200);

    const loginSenhaAntiga = await injetar({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL_RESET, senha: senhaOriginal },
    });
    expect(loginSenhaAntiga.statusCode).toBe(401);

    const loginSenhaNova = await injetar({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL_RESET, senha: senhaNova },
    });
    expect(loginSenhaNova.statusCode).toBe(200);
  });

  it("um código de reset_senha não ativa uma conta (isolamento por purpose)", async () => {
    // O teste anterior já emitiu um código reset_senha para este usuário e segura a trava
    // de cooldown de 30s — sem liberar, esta chamada cairia em "em_andamento" e nenhum
    // e-mail novo seria "enviado" ao mock.
    const usuarioReset = await getPool().then((pool) =>
      pool.request().input("email", sql.NVarChar, EMAIL_RESET).query<{ id: string }>("SELECT id FROM Usuario WHERE email = @email")
    );
    await limparLockEmissaoParaTeste(usuarioReset.recordset[0].id, "reset_senha");

    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    await injetar({ method: "POST", url: "/api/v1/auth/recuperar-senha", payload: { email: EMAIL_RESET } });
    const codigoDeReset = extrairCodigoDoTexto(mock.mensagensEnviadas.at(-1)!.text);

    const tentarAtivar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_RESET, codigo: codigoDeReset, senha: "OutraSenhaForte789" },
    });
    expect(tentarAtivar.statusCode).toBe(400);
    expect(tentarAtivar.json().erro).toMatch(/inválido/i);
  });
});

describe("Fluxo D — Autocadastro (sem ação do Admin)", () => {
  it("cria a conta como colaborador, envia o código de verdade, e o código do e-mail ativa a conta", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    const cadastrar = await injetar({
      method: "POST",
      url: "/api/v1/auth/cadastrar",
      payload: { nome: "Teste Autocadastro", email: EMAIL_AUTOCADASTRO, setorId: setorTiId },
    });
    expect(cadastrar.statusCode).toBe(200);
    expect(mock.mensagensEnviadas).toHaveLength(1);
    expect(mock.mensagensEnviadas[0].to).toBe(EMAIL_AUTOCADASTRO);
    expect(mock.mensagensEnviadas[0].subject).toMatch(/Ativação de conta/);

    const pool = await getPool();
    const usuario = await pool
      .request()
      .input("email", sql.NVarChar, EMAIL_AUTOCADASTRO)
      .query<{ id: string; perfil: string; ativo: boolean; email_verificado: boolean }>(
        "SELECT id, perfil, ativo, email_verificado FROM Usuario WHERE email = @email"
      );
    idsCriados.push(usuario.recordset[0].id);
    // Ninguém escolheu o perfil no payload (o schema nem aceita esse campo) — a conta
    // nasce sempre colaborador, nunca admin/gestor_setor por autocadastro.
    expect(usuario.recordset[0].perfil).toBe("colaborador");
    expect(usuario.recordset[0].ativo).toBe(true);
    expect(usuario.recordset[0].email_verificado).toBe(false);

    const codigo = extrairCodigoDoTexto(mock.mensagensEnviadas[0].text);
    const ativar = await injetar({
      method: "POST",
      url: "/api/v1/auth/ativar-conta",
      payload: { email: EMAIL_AUTOCADASTRO, codigo, senha: "SenhaForte123" },
    });
    expect(ativar.statusCode).toBe(200);
  });

  it("cadastro repetido para uma conta pendente reenvia em vez de tentar criar de novo (sem violar UNIQUE)", async () => {
    const mock1 = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock1);
    const primeiro = await injetar({
      method: "POST",
      url: "/api/v1/auth/cadastrar",
      payload: { nome: "Teste Pendente", email: EMAIL_AUTOCADASTRO_PENDENTE, setorId: setorTiId },
    });
    expect(primeiro.statusCode).toBe(200);

    const pool = await getPool();
    const usuario = await pool
      .request()
      .input("email", sql.NVarChar, EMAIL_AUTOCADASTRO_PENDENTE)
      .query<{ id: string }>("SELECT id FROM Usuario WHERE email = @email");
    idsCriados.push(usuario.recordset[0].id);
    await limparLockEmissaoParaTeste(usuario.recordset[0].id, "ativacao_conta");

    const mock2 = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock2);
    const segundo = await injetar({
      method: "POST",
      url: "/api/v1/auth/cadastrar",
      payload: { nome: "Teste Pendente", email: EMAIL_AUTOCADASTRO_PENDENTE, setorId: setorTiId },
    });
    expect(segundo.statusCode).toBe(200);
    expect(mock2.mensagensEnviadas).toHaveLength(1);

    // Continua exatamente UM usuário com este e-mail (não duplicou a linha).
    const contagem = await pool
      .request()
      .input("email", sql.NVarChar, EMAIL_AUTOCADASTRO_PENDENTE)
      .query<{ total: number }>("SELECT COUNT(*) AS total FROM Usuario WHERE email = @email");
    expect(contagem.recordset[0].total).toBe(1);
  });

  it("cadastro para e-mail já ativo responde genérico e NÃO envia nada (anti-enumeração)", async () => {
    const senhaHash = await hashPassword("SenhaForte123");
    const pool = await getPool();
    const inserir = await pool
      .request()
      .input("nome", sql.NVarChar, "Teste Ja Ativo")
      .input("email", sql.NVarChar, EMAIL_AUTOCADASTRO_ATIVO)
      .input("senha_hash", sql.VarChar, senhaHash)
      .input("setor_id", sql.UniqueIdentifier, setorTiId)
      .query<{ id: string }>(
        `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
         OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
      );
    idsCriados.push(inserir.recordset[0].id);

    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);
    const resposta = await injetar({
      method: "POST",
      url: "/api/v1/auth/cadastrar",
      payload: { nome: "Teste Ja Ativo", email: EMAIL_AUTOCADASTRO_ATIVO, setorId: setorTiId },
    });
    expect(resposta.statusCode).toBe(200);
    expect(mock.mensagensEnviadas).toHaveLength(0);
  });

  it("setorId inválido é rejeitado com 422 (não deixa a constraint de FK vazar erro cru)", async () => {
    const resposta = await injetar({
      method: "POST",
      url: "/api/v1/auth/cadastrar",
      payload: { nome: "Teste Setor Invalido", email: "teste.setor.invalido@metalsider.com.br", setorId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(resposta.statusCode).toBe(422);
  });
});
