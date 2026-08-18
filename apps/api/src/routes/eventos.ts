import type { FastifyInstance } from "fastify";
import { verificarToken } from "../utils/jwt.js";
import { enviarHeartbeat, registrarClienteSSE, removerClienteSSE } from "../services/eventos.service.js";
import { isAllowedOrigin } from "../utils/cors.js";

const HEARTBEAT_MS = 20_000;

// SDD §3.4 / §11: canal único de eventos em tempo real, consumido por Central de Operações,
// Reservas, Calendário, Checklists e pelo sino de notificações.
//
// A autenticação era dupla — cookie JWT OU token de dispositivo via querystring. O segundo
// caminho existia exclusivamente para o Painel TV, que foi removido do produto; sem ele,
// aceitar um token na querystring seria apenas uma superfície de autenticação a mais sem
// nenhum consumidor.
export async function eventosRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/eventos", async (request, reply) => {
    const token = request.cookies?.token;
    let usuarioId: string | null = null;
    if (token) {
      try {
        usuarioId = verificarToken(token).sub;
      } catch {
        // cookie inválido/expirado — tratado como não autenticado abaixo
      }
    }
    if (!usuarioId) {
      return reply.status(401).send({ erro: "Não autenticado." });
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
      // Proxies corporativos com buffer (nginx e afins) só entregam o stream em blocos —
      // a tela parece congelada até o buffer encher. Este header desliga o buffer.
      "X-Accel-Buffering": "no",
    });
    // Sem Nagle, cada evento sai imediatamente em vez de esperar acumular no socket.
    reply.raw.socket?.setNoDelay(true);
    reply.raw.write(": conectado\n\n");

    const clienteId = registrarClienteSSE(usuarioId, reply);
    const heartbeat = setInterval(() => enviarHeartbeat(clienteId), HEARTBEAT_MS);

    const encerrar = () => {
      clearInterval(heartbeat);
      removerClienteSSE(clienteId);
    };
    request.raw.on("close", encerrar);
    // 'close' do request não dispara para todo tipo de queda (reset de TCP pelo proxy,
    // erro de escrita no socket) — sem estes dois, o intervalo de heartbeat continuaria
    // rodando para sempre num cliente que já não existe (vazamento de timer e de entrada
    // no Map, acumulando a cada reconexão do backoff exponencial do frontend).
    reply.raw.on("close", encerrar);
    reply.raw.on("error", encerrar);
  });
}
