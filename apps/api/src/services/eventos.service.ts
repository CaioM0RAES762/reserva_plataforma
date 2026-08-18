import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";

// SDD §3.4 — canal único de comunicação em tempo real (SSE). Um cliente é ou um usuário
// autenticado (usuarioId preenchido — recebe eventos pessoais como notificacao.nova) ou
// um cliente sem usuário associado (usuarioId nulo — recebe apenas os eventos globais, nunca
// notificações pessoais de outro usuário).
interface ClienteSSE {
  id: string;
  usuarioId: string | null;
  reply: FastifyReply;
}

const clientes = new Map<string, ClienteSSE>();

export function registrarClienteSSE(usuarioId: string | null, reply: FastifyReply): string {
  const id = randomUUID();
  clientes.set(id, { id, usuarioId, reply });
  return id;
}

export function removerClienteSSE(id: string): void {
  clientes.delete(id);
}

export function contarClientesConectados(): number {
  return clientes.size;
}

// Escreve no socket de um cliente isolando a falha: um socket já encerrado (aba fechada
// sem o evento 'close' ter chegado, proxy que derrubou a conexão) fazia `write` lançar e,
// como a publicação percorria o Map num laço simples, o erro abortava a entrega para
// todos os clientes seguintes. Agora o cliente morto é descartado e o fan-out continua.
function escreverEvento(cliente: ClienteSSE, tipo: string, dados: unknown): boolean {
  const socket = cliente.reply.raw;
  if (socket.writableEnded || socket.destroyed) {
    clientes.delete(cliente.id);
    return false;
  }
  try {
    socket.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
    return true;
  } catch {
    clientes.delete(cliente.id);
    return false;
  }
}

// Eventos pessoais: reserva.criada (ao aprovador elegível), reserva.aprovada/rejeitada
// (ao solicitante), notificacao.nova (ao destinatário da Notificacao persistida).
export function publicarEventoUsuario(usuarioId: string, tipo: string, dados: unknown): number {
  let entregues = 0;
  // Snapshot da lista: escreverEvento pode remover clientes do Map durante a iteração.
  for (const cliente of [...clientes.values()]) {
    if (cliente.usuarioId === usuarioId && escreverEvento(cliente, tipo, dados)) {
      entregues += 1;
    }
  }
  return entregues;
}

// Eventos globais: reserva.status_alterado e plataforma.status_alterado — consumidos por
// Central de Operações, Reservas e Calendário de qualquer usuário conectado (SDD §3.4).
export function publicarEventoGlobal(tipo: string, dados: unknown): number {
  let entregues = 0;
  for (const cliente of [...clientes.values()]) {
    if (escreverEvento(cliente, tipo, dados)) {
      entregues += 1;
    }
  }
  return entregues;
}

// Heartbeat de keep-alive (comentário SSE, ignorado pelo EventSource) — mesma proteção
// contra socket morto usada nos eventos de domínio.
export function enviarHeartbeat(clienteId: string): void {
  const cliente = clientes.get(clienteId);
  if (!cliente) return;
  const socket = cliente.reply.raw;
  if (socket.writableEnded || socket.destroyed) {
    clientes.delete(clienteId);
    return;
  }
  try {
    socket.write(": heartbeat\n\n");
  } catch {
    clientes.delete(clienteId);
  }
}
