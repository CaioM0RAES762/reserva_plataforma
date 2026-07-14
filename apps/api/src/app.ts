import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { authRoutes } from "./routes/auth.js";
import { contaRoutes } from "./routes/conta.js";
import { plataformasRoutes } from "./routes/plataformas.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { reservasRoutes } from "./routes/reservas.js";
import { historicoRoutes } from "./routes/historico.js";
import { setoresRoutes } from "./routes/setores.js";
import { usuariosRoutes } from "./routes/usuarios.js";
import { checklistRoutes } from "./routes/checklist.js";
import { bloqueiosRoutes } from "./routes/bloqueios.js";
import { eventosRoutes } from "./routes/eventos.js";
import { notificacoesRoutes } from "./routes/notificacoes.js";
import { painelRoutes } from "./routes/painel.js";
import { anexosRoutes } from "./routes/anexos.js";
import { comentariosRoutes } from "./routes/comentarios.js";
import { ocorrenciasRoutes } from "./routes/ocorrencias.js";
import { configuracoesRoutes } from "./routes/configuracoes.js";
import { auditoriaRoutes } from "./routes/auditoria.js";
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
  });
  // S6 (hardening): headers de segurança via Helmet. HSTS só em produção (RNF/§12 do SDD) —
  // em dev, sobre HTTP puro, o header seria ignorado pelo navegador mas polui os testes locais.
  await app.register(helmet, {
    hsts:
      isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
  });

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(contaRoutes);
  await app.register(plataformasRoutes);
  await app.register(dashboardRoutes);
  await app.register(reservasRoutes);
  await app.register(historicoRoutes);
  await app.register(setoresRoutes);
  await app.register(usuariosRoutes);
  await app.register(checklistRoutes);
  await app.register(bloqueiosRoutes);
  await app.register(eventosRoutes);
  await app.register(notificacoesRoutes);
  await app.register(painelRoutes);
  await app.register(anexosRoutes);
  await app.register(comentariosRoutes);
  await app.register(ocorrenciasRoutes);
  await app.register(configuracoesRoutes);
  await app.register(auditoriaRoutes);

  return app;
}
