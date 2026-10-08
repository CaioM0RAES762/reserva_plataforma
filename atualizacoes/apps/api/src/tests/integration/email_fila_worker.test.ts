import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { conexaoRedisDaUrl, criarWorkerEmail } from "../../services/emailFila.js";

/* Worker de e-mail num Redis real, mas em FILA DE NOME ISOLADO e com o provedor simulado:
 * nada chega à fila `email` (drenada pelo servidor de dev via SMTP) nem a uma caixa real. */

const connection = conexaoRedisDaUrl(process.env.REDIS_URL ?? "redis://localhost:6379");
const abertos: Array<{ close(): Promise<unknown> }> = [];

afterAll(async () => {
  for (const recurso of abertos.reverse()) await recurso.close().catch(() => undefined);
});

async function ambiente(enviar: (data: unknown) => Promise<unknown>) {
  const nomeFila = `email-teste-${randomUUID()}`;
  const fila = new Queue(nomeFila, { connection });
  const eventos = new QueueEvents(nomeFila, { connection });
  const falhasDefinitivas: string[] = [];
  const worker = criarWorkerEmail({
    nomeFila,
    connection,
    enviar,
    aoFalharDefinitivamente: (job, err) => falhasDefinitivas.push(`${job?.id}:${err.message}`),
  });
  abertos.push(fila, eventos, worker);
  await eventos.waitUntilReady();
  return { fila, eventos, falhasDefinitivas, limpar: () => fila.obliterate({ force: true }) };
}

const DADOS = { destinatario: "destino@exemplo.invalid", assunto: "Teste fila", corpoHtml: "<p>teste</p>" };

describe("conexaoRedisDaUrl", () => {
  it("respeita usuário, senha, banco e TLS do REDIS_URL", () => {
    expect(conexaoRedisDaUrl("rediss://app:s3nh%40@redis.interno:6380/2")).toMatchObject({
      host: "redis.interno",
      port: 6380,
      username: "app",
      password: "s3nh@",
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
    const simples = conexaoRedisDaUrl("redis://localhost:6379") as Record<string, unknown>;
    expect(simples).toMatchObject({ host: "localhost", port: 6379 });
    expect(simples.password).toBeUndefined();
    expect(simples.tls).toBeUndefined();
  });
});

describe("fila de e-mail → worker", () => {
  it("o job entra na fila e é consumido pelo worker (provedor chamado com os dados)", async () => {
    const enviar = vi.fn(async (_dados: unknown) => ({ success: true }));
    const { fila, eventos, limpar } = await ambiente(enviar);
    const job = await fila.add("enviar", DADOS, { attempts: 3, backoff: { type: "fixed", delay: 50 } });
    await job.waitUntilFinished(eventos, 15_000);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0][0]).toMatchObject(DADOS);
    await limpar();
  });

  it("falha temporária é repetida e o job conclui na tentativa seguinte", async () => {
    let tentativas = 0;
    const enviar = vi.fn(async () => {
      tentativas += 1;
      if (tentativas === 1) throw new Error("SMTP indisponível (temporário)");
      return { success: true };
    });
    const { fila, eventos, falhasDefinitivas, limpar } = await ambiente(enviar);
    const job = await fila.add("enviar", DADOS, { attempts: 3, backoff: { type: "fixed", delay: 50 } });
    await job.waitUntilFinished(eventos, 15_000);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect((await fila.getJob(job.id!))?.attemptsMade).toBe(2);
    expect(falhasDefinitivas).toEqual([]);
    await limpar();
  });

  it("falha em todas as tentativas registra a falha definitiva", async () => {
    const enviar = vi.fn(async () => {
      throw new Error("rejeitado pelo provedor");
    });
    const { fila, eventos, falhasDefinitivas, limpar } = await ambiente(enviar);
    const erroLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const job = await fila.add("enviar", DADOS, { attempts: 2, backoff: { type: "fixed", delay: 50 } });
    await expect(job.waitUntilFinished(eventos, 15_000)).rejects.toThrow("rejeitado pelo provedor");
    // O handler `failed` do worker roda logo após o evento; espera ele registrar.
    await vi.waitFor(() => expect(falhasDefinitivas).toHaveLength(1));
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(erroLog.mock.calls.some(([m]) => String(m).includes("falhou definitivamente após 2 tentativa(s)"))).toBe(true);
    erroLog.mockRestore();
    await limpar();
  });
});
