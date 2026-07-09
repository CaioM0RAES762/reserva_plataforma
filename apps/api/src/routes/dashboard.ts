import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard/kpis", { preHandler: autenticar }, async (_request, reply) => {
    const pool = await getPool();
    const result = await pool
      .request()
      .query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'disponivel' THEN 1 ELSE 0 END) AS disponiveis
         FROM Plataforma`
      );
    const row = result.recordset[0];
    return reply.status(200).send({
      totalPlataformas: row.total ?? 0,
      disponiveis: row.disponiveis ?? 0,
    });
  });
}
