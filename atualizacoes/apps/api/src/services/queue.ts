import { Queue, Worker } from "bullmq";
import "dotenv/config";
import { enviarEmail, type EmailJobData } from "./email.service.js";
import { conexaoRedisDaUrl, criarWorkerEmail, OPCOES_JOB_EMAIL } from "./emailFila.js";

// Objeto de opções (não uma instância de ioredis) para evitar conflito de tipos entre a
// versão de ioredis do projeto e a interna do bullmq. Usuário/senha/banco/TLS do REDIS_URL
// são respeitados (ver conexaoRedisDaUrl) — API e worker usam exatamente esta conexão.
const connection = conexaoRedisDaUrl(process.env.REDIS_URL ?? "redis://localhost:6379");

export const EMAIL_QUEUE_NAME = "email";

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, { connection });

// Sem o log de falha definitiva, um job que esgota as tentativas ficaria "failed" no Redis
// sem ninguém saber. `enviarEmail` loga cada tentativa; o worker loga retry e desistência.
export function iniciarEmailWorker(): Worker<EmailJobData> {
  return criarWorkerEmail({ nomeFila: EMAIL_QUEUE_NAME, connection, enviar: enviarEmail });
}

// Notificações em massa (aprovações, SLA, comentários, ocorrências) usam a fila: a
// latência de segundos importa menos aqui do que numa rota onde o usuário está parado na
// tela esperando o código. Códigos de verificação (ativação/reset de senha) NUNCA passam
// por aqui — usam `enviarEmail`/`emitirEEnviarCodigo` de forma bloqueante, com o resultado
// real refletido na resposta HTTP (ver otp.service.ts e o comentário histórico que existia
// antes: o caminho fire-and-forget respondia sucesso sem nunca confirmar o envio).
export async function enfileirarEmail(data: EmailJobData): Promise<void> {
  await emailQueue.add("enviar", data, OPCOES_JOB_EMAIL);
}

/* A fila "escalonamento-sla" foi REMOVIDA junto com o fluxo de aprovação (migration
 * 0018): ela existia para cobrar decisão de aprovadores sobre reservas urgentes que
 * ficavam paradas. Sem aprovação, nenhuma reserva fica parada esperando alguém.
 *
 * Se um ambiente já tiver o job repetitivo registrado no Redis, ele deixa de ter worker e
 * `removerJobsLegadosDeEscalonamento` abaixo limpa o agendamento residual no boot. */

const ESCALONAMENTO_QUEUE_NAME_LEGADO = "escalonamento-sla";

/** Best-effort: um Redis indisponível não deve impedir a API de subir. */
export async function removerJobsLegadosDeEscalonamento(): Promise<void> {
  try {
    const fila = new Queue(ESCALONAMENTO_QUEUE_NAME_LEGADO, { connection });
    for (const job of await fila.getRepeatableJobs()) {
      await fila.removeRepeatableByKey(job.key);
    }
    await fila.obliterate({ force: true });
    await fila.close();
  } catch {
    // Nada a fazer: a fila legada sem worker é inerte de qualquer forma.
  }
}

// Automação de início/finalização de reserva — job repetitivo BullMQ, reaproveitando a
// infraestrutura Redis que o projeto já tem (nenhuma tecnologia nova foi introduzida).
//
// Com o fim do fluxo de aprovação, este job passou de acessório a ESSENCIAL: ele é o que
// move a reserva de agendada → em uso → concluída. É a fonte de verdade do status
// temporal, e por isso vive no servidor — nunca num setInterval de página React.
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
