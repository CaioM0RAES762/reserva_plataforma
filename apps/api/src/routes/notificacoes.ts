import type { FastifyInstance } from "fastify";
import type { TipoNotificacao } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";

interface NotificacaoRow {
  id: string;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  link: string | null;
  lida: boolean;
  criado_em: Date;
}

function mapNotificacao(row: NotificacaoRow) {
  return {
    id: row.id,
    tipo: row.tipo,
    titulo: row.titulo,
    mensagem: row.mensagem,
    link: row.link,
    lida: row.lida,
    criadoEm: row.criado_em.toISOString(),
  };
}

// RF-NOT-01/02: sino do topbar (contador de não lidas via SSE) + dropdown de listagem.
export async function notificacoesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/notificacoes", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
      .query<NotificacaoRow>(
        `SELECT TOP 50 id, tipo, titulo, mensagem, link, lida, criado_em
         FROM Notificacao WHERE usuario_id = @usuario_id ORDER BY criado_em DESC`
      );
    return reply.status(200).send(result.recordset.map(mapNotificacao));
  });

  app.patch("/api/v1/notificacoes/:id/lida", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = await getPool();

    const atual = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
      .query("SELECT id FROM Notificacao WHERE id = @id AND usuario_id = @usuario_id");
    if (atual.recordset.length === 0) {
      return reply.status(404).send({ erro: "Notificação não encontrada." });
    }

    await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query("UPDATE Notificacao SET lida = 1 WHERE id = @id");
    return reply.status(204).send();
  });

  app.patch("/api/v1/notificacoes/lidas", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
      .query("UPDATE Notificacao SET lida = 1 WHERE usuario_id = @usuario_id AND lida = 0");
    return reply.status(204).send();
  });
}
