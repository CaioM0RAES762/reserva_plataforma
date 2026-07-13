import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";

// SDD §3.4 — canal único de comunicação em tempo real (SSE). Um cliente é ou um usuário
// autenticado (usuarioId preenchido — recebe eventos pessoais como notificacao.nova) ou
// um dispositivo do Painel TV (usuarioId nulo — recebe apenas os eventos globais, nunca
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

function escreverEvento(reply: FastifyReply, tipo: string, dados: unknown): void {
  reply.raw.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
}

// Eventos pessoais: reserva.criada (ao aprovador elegível), reserva.aprovada/rejeitada
// (ao solicitante), notificacao.nova (ao destinatário da Notificacao persistida).
export function publicarEventoUsuario(usuarioId: string, tipo: string, dados: unknown): void {
  for (const cliente of clientes.values()) {
    if (cliente.usuarioId === usuarioId) {
      escreverEvento(cliente.reply, tipo, dados);
    }
  }
}

// Eventos globais: reserva.status_alterado e plataforma.status_alterado — consumidos por
// Dashboard, Painel TV e Calendário de qualquer usuário/dispositivo conectado (SDD §3.4).
export function publicarEventoGlobal(tipo: string, dados: unknown): void {
  for (const cliente of clientes.values()) {
    escreverEvento(cliente.reply, tipo, dados);
  }
}
