import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { getPool, sql, closePool } from "../../db/pool.js";
import { hashPassword } from "../../utils/password.js";

// S10 — SDD §3.4: canal único de eventos em tempo real (SSE). app.inject() (usado em
// todos os outros testes de integração) não abre uma conexão TCP real e não é adequado
// para verificar um stream contínuo — por isso este arquivo sobe o servidor de verdade
// (app.listen em porta efêmera) e consome /api/v1/eventos com um cliente HTTP real
// (fetch + ReadableStream), disparando a mutação por uma segunda conexão (app.inject).

const EMAIL_COLABORADOR = "teste.s10.colaborador@metalsider.com.br";
const SENHA = "SenhaForte123";
const CODIGO_PLATAFORMA = "PLT-S10-TESTE";

let app: FastifyInstance;
let baseUrl: string;
let setorTiId: string;
let plataformaId: string;
let colaboradorId: string;
let cookieColaborador: string;
let cookieAdmin: string;

function extrairCookieToken(setCookieHeaders: string[] | undefined): string {
  const linha = (setCookieHeaders ?? []).find((c) => c.startsWith("token="));
  if (!linha) throw new Error("Cookie de sessão não encontrado na resposta de login.");
  return linha.split(";")[0];
}

function withTimeout<T>(promise: Promise<T>, ms: number, mensagem: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(mensagem)), ms)),
  ]);
}

// Mantém um buffer compartilhado entre chamadas — dois eventos publicados em sequência
// rápida (ex.: reserva.criada + notificacao.nova, escritos um após o outro no mesmo loop
// do backend) podem chegar no MESMO chunk do stream; ler o "primeiro" evento e descartar
// o restante do chunk faria o segundo evento se perder, travando a próxima espera.
function criarLeitorSSE(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";

  async function aguardarEvento(tipoEsperado: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const prazo = Date.now() + timeoutMs;
    for (;;) {
      const indice = buffer.indexOf(`event: ${tipoEsperado}\n`);
      if (indice !== -1) {
        const resto = buffer.slice(indice);
        const fimBloco = resto.indexOf("\n\n");
        const bloco = fimBloco === -1 ? resto : resto.slice(0, fimBloco);
        buffer = buffer.slice(0, indice) + (fimBloco === -1 ? "" : resto.slice(fimBloco + 2));
        const linhaDados = bloco.split("\n").find((linha) => linha.startsWith("data: "));
        if (!linhaDados) {
          throw new Error(`Evento "${tipoEsperado}" recebido sem linha "data:". Bloco: ${bloco}`);
        }
        return JSON.parse(linhaDados.slice("data: ".length));
      }

      const restante = prazo - Date.now();
      if (restante <= 0) {
        throw new Error(`Timeout aguardando evento SSE "${tipoEsperado}". Buffer atual: ${buffer}`);
      }
      const { value, done } = await withTimeout(
        reader.read(),
        restante,
        `Timeout de leitura do stream SSE (evento "${tipoEsperado}").`
      );
      if (done) {
        throw new Error(`Conexão SSE encerrada antes do evento "${tipoEsperado}" chegar.`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return { aguardarEvento };
}

async function limparDados(pool: Awaited<ReturnType<typeof getPool>>) {
  await pool.request().query(
    `DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = '${EMAIL_COLABORADOR}')
       OR usuario_id IN (SELECT id FROM Usuario WHERE email = '${process.env.SEED_ADMIN_EMAIL}')`
  );
  await pool.request().query(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (
       SELECT id FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')
     )`
  );
  await pool
    .request()
    .query(`DELETE FROM Reserva WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}')`);
  await pool.request().query(`DELETE FROM Plataforma WHERE codigo = '${CODIGO_PLATAFORMA}'`);
  await pool.request().query(`DELETE FROM Usuario WHERE email = '${EMAIL_COLABORADOR}'`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const endereco = app.server.address();
  if (!endereco || typeof endereco === "string") {
    throw new Error("Falha ao obter a porta efêmera do servidor de teste.");
  }
  baseUrl = `http://127.0.0.1:${endereco.port}`;

  const pool = await getPool();
  await limparDados(pool);

  const setorTi = await pool.request().query("SELECT id FROM Setor WHERE nome = 'TI'");
  setorTiId = setorTi.recordset[0].id;

  const plataforma = await pool
    .request()
    .input("codigo", sql.VarChar, CODIGO_PLATAFORMA)
    .input("nome", sql.NVarChar, "Plataforma de Teste S10")
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, categoria, risco) OUTPUT INSERTED.id VALUES (@codigo, @nome, 'sala', 'baixo')`
    );
  plataformaId = plataforma.recordset[0].id;

  const senhaHash = await hashPassword(SENHA);
  const colaborador = await pool
    .request()
    .input("nome", sql.NVarChar, "Colaborador Teste S10")
    .input("email", sql.NVarChar, EMAIL_COLABORADOR)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("setor_id", sql.UniqueIdentifier, setorTiId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 1)`
    );
  colaboradorId = colaborador.recordset[0].id;

  const loginAdmin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, senha: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(loginAdmin.statusCode).toBe(200);
  cookieAdmin = extrairCookieToken(loginAdmin.cookies.map((c) => `${c.name}=${c.value}`));

  const loginColaborador = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: EMAIL_COLABORADOR, senha: SENHA },
  });
  expect(loginColaborador.statusCode).toBe(200);
  cookieColaborador = extrairCookieToken(loginColaborador.cookies.map((c) => `${c.name}=${c.value}`));
});

afterAll(async () => {
  const pool = await getPool();
  await limparDados(pool);
  await app.close();
  await closePool();
});

describe("SSE — GET /api/v1/eventos (S10, SDD §3.4)", () => {
  it(
    "evento reserva.criada, publicado na criação de uma reserva, é recebido em tempo real por um cliente SSE assinado como Admin",
    async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/eventos`, {
        headers: { cookie: cookieAdmin },
      });
      expect(resposta.status).toBe(200);
      expect(resposta.headers.get("content-type")).toContain("text/event-stream");
      expect(resposta.body).not.toBeNull();

      const reader = resposta.body!.getReader();
      const leitor = criarLeitorSSE(reader);
      try {
        // Dispara a mutação por uma segunda conexão — a reserva.criada deve chegar ao
        // Admin (aprovador elegível) assinado no stream acima, sem qualquer polling.
        const criacao = await app.inject({
          method: "POST",
          url: "/api/v1/reservas",
          headers: { cookie: cookieColaborador },
          payload: {
            plataformaId,
            data: "2026-10-05",
            horaInicio: "09:00",
            horaFim: "10:00",
            motivo: "Reserva de teste do canal SSE — S10",
          },
        });
        expect(criacao.statusCode).toBe(201);
        const reservaCriada = criacao.json();

        const payloadRecebido = await leitor.aguardarEvento("reserva.criada", 5000);
        expect(payloadRecebido.id).toBe(reservaCriada.id);
        expect(payloadRecebido.status).toBe("pendente");

        const payloadNotificacao = await leitor.aguardarEvento("notificacao.nova", 2000);
        expect(payloadNotificacao.tipo).toBe("reserva_pendente");
        expect(payloadNotificacao.lida).toBe(false);
      } finally {
        await reader.cancel();
      }
    },
    15000
  );

  it("GET /api/v1/eventos sem cookie e sem token de dispositivo retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/eventos`);
    expect(resposta.status).toBe(401);
  });
});
