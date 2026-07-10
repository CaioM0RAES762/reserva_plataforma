import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { closePool } from "../../db/pool.js";

// Sprint S6 — confirma que os headers de segurança (Helmet) estão presentes nas respostas.
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("Segurança (S6) — headers Helmet presentes nas respostas", () => {
  it("GET /api/v1/health retorna headers de segurança padrão do Helmet", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
    // HSTS só é habilitado em produção (ver ADR do relatório S6) — em teste (NODE_ENV=test)
    // o header não deve ser enviado.
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });
});
