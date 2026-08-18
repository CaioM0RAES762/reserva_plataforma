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
  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      await enviarEmail(job.data, { tipo: "NOTIFICATION", correlationId: job.id });
    },
    { connection }
  );

  // Sem isto, um job que esgota as 3 tentativas fica "failed" no Redis e ninguém nunca
  // fica sabendo — a notificação (reserva aprovada, SLA estourado etc.) simplesmente não
  // chega, sem log algum. `enviarEmail` já loga cada tentativa individual; isto aqui é o
  // log de "desistiu depois de todas as tentativas".
  worker.on("failed", (job, err) => {
    console.error(
      `[EMAIL][fila] job ${job?.id ?? "?"} falhou definitivamente após ${job?.attemptsMade ?? "?"} tentativa(s): ${err.message}`
    );
  });
  worker.on("error", (err) => {
    console.error(`[EMAIL][fila] erro no worker: ${err.message}`);
  });

  return worker;
}

// Notificações em massa (aprovações, SLA, comentários, ocorrências) usam a fila: a
// latência de segundos importa menos aqui do que numa rota onde o usuário está parado na
// tela esperando o código. Códigos de verificação (ativação/reset de senha) NUNCA passam
// por aqui — usam `enviarEmail`/`emitirEEnviarCodigo` de forma bloqueante, com o resultado
// real refletido na resposta HTTP (ver otp.service.ts e o comentário histórico que existia
// antes: o caminho fire-and-forget respondia sucesso sem nunca confirmar o envio).
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

// Automação de início/finalização de reserva — mesmo padrão de job repetitivo do
// escalonamento de SLA acima, reaproveitando a infraestrutura BullMQ/Redis que o projeto já
// tem (nenhuma tecnologia nova foi introduzida para isto).
//
// Por que no backend e não com setInterval no navegador: a regra precisa valer com a
// aplicação fechada. Uma reserva 15:00–16:30 tem de virar "em uso" às 15:00 mesmo que
// ninguém esteja com a tela aberta — e um timer no cliente ainda multiplicaria a mesma
// transição por aba aberta.
export const AUTOMACAO_QUEUE_NAME = "automacao-reserva";
export const AUTOMACAO_JOB_ID = "automacao-reserva-repetitivo";
// Um minuto: é a menor granularidade que os horários de reserva têm (HH:MM), então
// verificar com mais frequência não antecipa nada. O atraso máximo entre o horário
// agendado e a transição é, portanto, de até 1 minuto.
const AUTOMACAO_INTERVALO_MS = 60 * 1000;

export const automacaoQueue = new Queue(AUTOMACAO_QUEUE_NAME, { connection });

export function iniciarAutomacaoWorker(): Worker {
  const worker = new Worker(
    AUTOMACAO_QUEUE_NAME,
    async () => {
      const { processarAutomacaoReservas } = await import("./automacaoReserva.service.js");
      const resumo = await processarAutomacaoReservas();
      if (resumo.iniciadas.length > 0 || resumo.concluidas.length > 0) {
        console.log(
          `[AUTOMACAO] ${resumo.iniciadas.length} reserva(s) iniciada(s), ${resumo.concluidas.length} concluída(s).`
        );
      }
    },
    { connection }
  );
  worker.on("failed", (job, err) => {
    console.error(`[AUTOMACAO] execução ${job?.id ?? "?"} falhou: ${err.message}`);
  });
  worker.on("error", (err) => {
    console.error(`[AUTOMACAO] erro no worker: ${err.message}`);
  });
  return worker;
}

export async function agendarAutomacaoRepetitiva(): Promise<void> {
  await automacaoQueue.add(
    "processar",
    {},
    {
      repeat: { every: AUTOMACAO_INTERVALO_MS },
      jobId: AUTOMACAO_JOB_ID,
      // Uma execução perdida não deve se acumular como fila de trabalho atrasado: cada
      // execução recalcula o estado atual do zero, então a próxima já cobre o que a
      // anterior deixou passar.
      removeOnComplete: true,
      removeOnFail: 50,
    }
  );
}
