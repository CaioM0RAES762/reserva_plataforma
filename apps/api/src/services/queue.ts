import { Queue, Worker, type Job, type ConnectionOptions } from "bullmq";
import "dotenv/config";
import { enviarEmail, type EmailJobData } from "./email.service.js";

// Passado como objeto de opções (não uma instância de ioredis) para evitar conflito
// de tipos entre a versão de ioredis do projeto e a versão interna usada pelo bullmq.
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  maxRetriesPerRequest: null,
};

export const EMAIL_QUEUE_NAME = "email";

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, { connection });

export function iniciarEmailWorker(): Worker<EmailJobData> {
  return new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      await enviarEmail(job.data);
    },
    { connection }
  );
}

export async function enfileirarEmail(data: EmailJobData): Promise<void> {
  await emailQueue.add("enviar", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

// S7 (RN-RES-09) — job repetitivo de escalonamento de SLA de aprovação urgente.
// A checagem em si (verificarEscalonamentoSla) vive em escalonamento.service.ts, que
// importa enfileirarEmail deste módulo; o worker importa a checagem dinamicamente para
// evitar um ciclo de import estático entre os dois arquivos.
export const ESCALONAMENTO_QUEUE_NAME = "escalonamento-sla";
export const ESCALONAMENTO_JOB_ID = "escalonamento-sla-repetitivo";
const ESCALONAMENTO_INTERVALO_MS = 15 * 60 * 1000;

export const escalonamentoQueue = new Queue(ESCALONAMENTO_QUEUE_NAME, { connection });

export function iniciarEscalonamentoWorker(): Worker {
  return new Worker(
    ESCALONAMENTO_QUEUE_NAME,
    async () => {
      const { verificarEscalonamentoSla } = await import("./escalonamento.service.js");
      await verificarEscalonamentoSla();
    },
    { connection }
  );
}

export async function agendarEscalonamentoRepetitivo(): Promise<void> {
  await escalonamentoQueue.add(
    "verificar",
    {},
    { repeat: { every: ESCALONAMENTO_INTERVALO_MS }, jobId: ESCALONAMENTO_JOB_ID }
  );
}
