import type { FastifyInstance } from "fastify";
import { verificarToken } from "../utils/jwt.js";
import { registrarClienteSSE, removerClienteSSE } from "../services/eventos.service.js";
import { validarTokenDispositivo } from "../services/painelToken.service.js";
import { isAllowedOrigin } from "../utils/cors.js";

const HEARTBEAT_MS = 20_000;

// SDD §3.4 / §11: canal único de eventos em tempo real. Autenticação dupla — cookie JWT
// (usuário logado, RF-NOT-01) OU token de dispositivo via querystring (Painel TV, RF-TV-02)
// — sem exigir sessão de usuário para o dispositivo, conforme SDD §12.
export async function eventosRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/eventos", async (request, reply) => {
    let usuarioId: string | null = null;

    const token = request.cookies?.token;
    if (token) {
      try {
        usuarioId = verificarToken(token).sub;
      } catch {
        // cookie inválido/expirado — cai para a tentativa de token de dispositivo abaixo
      }
    }

    if (!usuarioId) {
      const { token: deviceToken } = request.query as { token?: string };
      const tokenValido = deviceToken ? await validarTokenDispositivo(deviceToken) : null;
      if (!tokenValido) {
        return reply.status(401).send({ erro: "Não autenticado." });
      }
      // usuarioId permanece null: cliente do tipo "dispositivo" (Painel TV), só recebe
      // eventos globais (ver publicarEventoGlobal em eventos.service.ts).
    }

    // reply.hijack() entrega o controle da resposta HTTP crua ao handler — necessário
    // para manter a conexão aberta e escrever eventos fora do ciclo request/response
    // padrão do Fastify (sem isso, o Fastify tentaria finalizar a resposta ao handler
    // retornar, encerrando o stream SSE imediatamente). Isso também pula o hook onSend do
    // @fastify/cors (que só escreve os headers de CORS nesse ponto do ciclo normal) — sem
    // reaplicar manualmente aqui, o EventSource do navegador falha com ERR_FAILED antes
    // mesmo de disparar onerror (confirmado via curl: headers de CORS ausentes na resposta).
    const origin = request.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": conectado\n\n");

    const clienteId = registrarClienteSSE(usuarioId, reply);
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      removerClienteSSE(clienteId);
    });
  });
}
