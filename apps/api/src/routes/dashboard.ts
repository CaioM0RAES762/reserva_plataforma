import type { FastifyInstance } from "fastify";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";

// S7 — "Pendências de Aprovação": Admin vê todas as pendentes; Gestor de Setor só as do
// próprio setor que ainda aguardam sua própria decisão (mesmo critério da Fila de
// Aprovações); Colaborador não aprova, então o card não se aplica (0).
async function contarPendenciasAprovacao(
  pool: Awaited<ReturnType<typeof getPool>>,
  perfil: string,
  setorId: string | null
): Promise<number> {
  if (perfil === "admin") {
    const result = await pool.request().query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM Reserva WHERE status = 'pendente'"
    );
    return result.recordset[0]?.total ?? 0;
  }
  if (perfil === "gestor_setor") {
    const result = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM Reserva
         WHERE status = 'pendente' AND setor_id = @setor_id AND aprovado_por_id IS NULL`
      );
    return result.recordset[0]?.total ?? 0;
  }
  return 0;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard/kpis", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const [plataformasResult, pendenciasAprovacao] = await Promise.all([
      pool
        .request()
        .query(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'disponivel' THEN 1 ELSE 0 END) AS disponiveis
           FROM Plataforma`
        ),
      contarPendenciasAprovacao(pool, request.usuario!.perfil, request.usuario!.setorId),
    ]);
    const row = plataformasResult.recordset[0];
    return reply.status(200).send({
      totalPlataformas: row.total ?? 0,
      disponiveis: row.disponiveis ?? 0,
      pendenciasAprovacao,
    });
  });
}
