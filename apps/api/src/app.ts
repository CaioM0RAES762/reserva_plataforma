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

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie);
  await app.register(cors, {
    origin: process.env.WEB_PUBLIC_API_URL ?? "http://localhost:3000",
    credentials: true,
  });
  // S6 (hardening): headers de segurança via Helmet. HSTS só em produção (RNF/§12 do SDD) —
  // em dev, sobre HTTP puro, o header seria ignorado pelo navegador mas polui os testes locais.
  await app.register(helmet, {
    hsts:
      process.env.NODE_ENV === "production"
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

  return app;
}
