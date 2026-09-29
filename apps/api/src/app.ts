import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { authRoutes } from "./routes/auth.js";
import { contaRoutes } from "./routes/conta.js";
import { plataformasRoutes } from "./routes/plataformas.js";
import { categoriasEquipamentoRoutes } from "./routes/categoriasEquipamento.js";
import { arquivosRoutes } from "./routes/arquivos.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { reservasRoutes } from "./routes/reservas.js";
import { historicoRoutes } from "./routes/historico.js";
import { setoresRoutes } from "./routes/setores.js";
import { usuariosRoutes } from "./routes/usuarios.js";
import { checklistRoutes } from "./routes/checklist.js";
import { bloqueiosRoutes } from "./routes/bloqueios.js";
import { eventosRoutes } from "./routes/eventos.js";
import { notificacoesRoutes } from "./routes/notificacoes.js";
import { anexosRoutes } from "./routes/anexos.js";
import { comentariosRoutes } from "./routes/comentarios.js";
import { naoConformidadesRoutes } from "./routes/naoConformidades.js";
import { ocorrenciasRoutes } from "./routes/ocorrencias.js";
import { configuracoesRoutes } from "./routes/configuracoes.js";
import { auditoriaRoutes } from "./routes/auditoria.js";
import { relatoriosRoutes } from "./routes/relatorios.js";
import { disponibilidadeRoutes } from "./routes/disponibilidade.js";
import { isAllowedOrigin } from "./utils/cors.js";

const isProduction = process.env.NODE_ENV === "production";

export async function buildApp(): Promise<FastifyInstance> {
  // S11 (RF-RES-14): anexos até 10 MB trafegam como data URL base64 no corpo JSON (mesmo
  // padrão de S8 para fotos de checklist) — base64 infla o payload em ~37%, então o limite
  // padrão do Fastify (1 MB) precisa subir para acomodar um anexo de 10 MB + overhead do JSON.
  const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin && isAllowedOrigin(origin) ? origin : false);
    },
    credentials: true,
    // Por padrão o navegador só deixa o JavaScript ler um punhado de headers "simples"
    // numa resposta cross-origin — os headers de paginação das listagens ficariam
    // invisíveis para o frontend (`headers.get("X-Total-Count")` devolvendo null), e a
    // paginação nunca saberia quantas páginas existem. O frontend roda em :3000 e a API
    // em :3335, então isto vale inclusive em desenvolvimento.
    exposedHeaders: ["X-Total-Count", "X-Limit", "X-Offset", "X-Cache", "Content-Disposition"],
  });
  // S6 (hardening): headers de segurança via Helmet. HSTS só em produção (RNF/§12 do SDD) —
  // em dev, sobre HTTP puro, o header seria ignorado pelo navegador mas polui os testes locais.
  await app.register(helmet, {
    hsts:
      isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
  });

  // Envelope de erro único em toda a API: `{ erro }` (mais `detalhes` quando é validação).
  // Sem isto, um erro não tratado escapava no formato padrão do Fastify
  // (`{ statusCode, error, message }`), que o cliente não sabe ler — a UI exibia sempre
  // "Erro inesperado." e a causa real ficava só no log do servidor.
  app.setErrorHandler((erro, request, reply) => {
    const status = erro.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: erro }, "erro não tratado");
      // Mensagem interna nunca vaza para o cliente em produção (pode conter SQL/caminhos).
      return reply.status(500).send({
        erro: isProduction
          ? "Erro interno do servidor. Tente novamente em instantes."
          : erro.message,
      });
    }

    // Payload maior que bodyLimit e JSON malformado chegam aqui como 4xx do próprio
    // Fastify — traduzidos para mensagens acionáveis em português.
    if (erro.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({ erro: "Arquivo ou requisição maior que o limite permitido (15 MB)." });
    }
    if (erro.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || erro.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(400).send({ erro: "Corpo da requisição inválido." });
    }

    return reply.status(status).send({ erro: erro.message });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ erro: `Rota não encontrada: ${request.method} ${request.url}` })
  );

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(contaRoutes);
  await app.register(plataformasRoutes);
  await app.register(categoriasEquipamentoRoutes);
  await app.register(arquivosRoutes);
  await app.register(dashboardRoutes);
  await app.register(reservasRoutes);
  await app.register(historicoRoutes);
  await app.register(setoresRoutes);
  await app.register(usuariosRoutes);
  await app.register(checklistRoutes);
  await app.register(bloqueiosRoutes);
  await app.register(eventosRoutes);
  await app.register(notificacoesRoutes);
  await app.register(anexosRoutes);
  await app.register(comentariosRoutes);
  await app.register(naoConformidadesRoutes);
  await app.register(ocorrenciasRoutes);
  await app.register(configuracoesRoutes);
  await app.register(auditoriaRoutes);
  await app.register(relatoriosRoutes);
  await app.register(disponibilidadeRoutes);

  return app;
}
