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
import { uploadsRoutes } from "./routes/uploads.js";

const isProduction = process.env.NODE_ENV === "production";

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
  "http://127.0.0.1:3003",
];

function getAllowedOrigins(): string[] {
  const configuredOrigins = process.env.WEB_ALLOWED_ORIGINS ?? process.env.WEB_PUBLIC_API_URL;
  const devOrigins = isProduction ? [] : DEFAULT_DEV_ORIGINS;

  if (configuredOrigins) {
    const origins = configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    return Array.from(new Set([...origins, ...devOrigins]));
  }

  return devOrigins;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  return getAllowedOrigins().includes(origin);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

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
  await app.register(uploadsRoutes);

  return app;
}
