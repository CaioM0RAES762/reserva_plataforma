import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { authRoutes } from "./routes/auth.js";
import { contaRoutes } from "./routes/conta.js";
import { plataformasRoutes } from "./routes/plataformas.js";
import { dashboardRoutes } from "./routes/dashboard.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cookie);
  await app.register(cors, {
    origin: process.env.WEB_PUBLIC_API_URL ?? "http://localhost:3000",
    credentials: true,
  });

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(contaRoutes);
  await app.register(plataformasRoutes);
  await app.register(dashboardRoutes);

  return app;
}
