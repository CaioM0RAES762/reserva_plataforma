import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";

interface SetorRow {
  id: string;
  nome: string;
  cor_hex: string;
}

// Leitura mínima para a legenda de setores do Calendário (RF-CAL-01). CRUD completo
// (criar/editar/desativar setor) só entra em S12 — esta rota é somente leitura.
export async function setoresRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/setores", { preHandler: autenticar }, async (_request, reply) => {
    const pool = await getPool();
    const result = await pool
      .request()
      .query<SetorRow>("SELECT id, nome, cor_hex FROM Setor WHERE ativo = 1 ORDER BY nome");
    return reply.status(200).send(
      result.recordset.map((row) => ({ id: row.id, nome: row.nome, corHex: row.cor_hex }))
    );
  });
}
