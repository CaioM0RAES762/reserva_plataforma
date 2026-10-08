import { Worker, type ConnectionOptions, type Job, type JobsOptions } from "bullmq";
import type { EmailJobData, EnviarEmailOpcoes } from "./email.service.js";

// Peças da fila de e-mail SEM estado global (queue.ts monta as instâncias reais com elas).
// Separadas para que o worker possa ser testado numa fila de nome isolado, com o provedor
// simulado — nunca na fila `email` real, que o servidor de desenvolvimento drena via SMTP.

/**
 * Conexão BullMQ a partir de REDIS_URL, respeitando usuário, senha, banco e TLS.
 *
 * Antes só host e porta eram lidos: com um Redis autenticado (comum em servidor), todo
 * `queue.add` falhava com NOAUTH — o e-mail de reserva nunca entrava na fila, enquanto os de
 * ativação/senha (envio direto, sem Redis) continuavam funcionando.
 */
export function conexaoRedisDaUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const banco = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(banco !== undefined && Number.isInteger(banco) ? { db: banco } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    // Exigido pelo BullMQ para conexões de worker (comandos bloqueantes).
    maxRetriesPerRequest: null,
  };
}

/** Retry de entrega: 3 tentativas com backoff exponencial (5s, 10s). */
export const OPCOES_JOB_EMAIL: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  // Histórico limitado: o Redis não acumula jobs concluídos indefinidamente.
  removeOnComplete: 500,
  removeOnFail: 1000,
};

export type EnviarEmailFn = (data: EmailJobData, opcoes?: EnviarEmailOpcoes) => Promise<unknown>;

export function criarWorkerEmail(params: {
  nomeFila: string;
  connection: ConnectionOptions;
  enviar: EnviarEmailFn;
  /** Log/observação de quem desistiu depois de todas as tentativas. */
  aoFalharDefinitivamente?: (job: Job<EmailJobData> | undefined, err: Error) => void;
}): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    params.nomeFila,
    async (job: Job<EmailJobData>) => {
      // Lançar aqui = falha da tentativa → BullMQ aplica o retry (enviarEmail nunca finge sucesso).
      const resultado = (await params.enviar(job.data, { tipo: "NOTIFICATION", correlationId: job.id })) as
        | { messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }
        | undefined;
      // Comprovante da entrega gravado no próprio job (returnvalue): permite auditar "o
      // provedor aceitou?" pela fila, sem depender do log do processo. Sem credenciais nem corpo.
      return {
        messageId: resultado?.messageId ?? null,
        aceitos: resultado?.accepted?.length ?? 0,
        rejeitados: resultado?.rejected?.length ?? 0,
        resposta: resultado?.response ?? null,
      };
    },
    { connection: params.connection }
  );

  worker.on("failed", (job, err) => {
    // `failed` dispara a cada tentativa; "definitivamente" só quando esgotou as tentativas.
    const tentativas = job?.opts.attempts ?? 1;
    if (!job || job.attemptsMade >= tentativas) {
      console.error(
        `[EMAIL][fila] job ${job?.id ?? "?"} falhou definitivamente após ${job?.attemptsMade ?? "?"} tentativa(s): ${err.message}`
      );
      params.aoFalharDefinitivamente?.(job, err);
    } else {
      console.warn(
        `[EMAIL][fila] job ${job.id} falhou na tentativa ${job.attemptsMade}/${tentativas} — nova tentativa agendada: ${err.message}`
      );
    }
  });
  worker.on("completed", (job) => {
    console.info(`[EMAIL][fila] job ${job.id} concluído (tentativas: ${job.attemptsMade})`);
  });
  worker.on("error", (err) => {
    console.error(`[EMAIL][fila] erro no worker: ${err.message}`);
  });
  return worker;
}
