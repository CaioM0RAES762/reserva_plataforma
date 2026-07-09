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
