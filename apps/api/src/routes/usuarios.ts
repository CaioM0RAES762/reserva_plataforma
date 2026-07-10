import type { FastifyInstance } from "fastify";
import { atualizarPerfilUsuarioSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";

// RF-USR-05 (S7) — mecanismo provisório de promoção/rebaixamento de perfil. A tela
// administrativa completa (CRUD de usuários) só entra em S12; esta rota existe só para
// permitir a criação de Gestores de Setor sem acesso direto ao banco.
export async function usuariosRoutes(app: FastifyInstance): Promise<void> {
  app.patch(
    "/api/v1/usuarios/:id/perfil",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarPerfilUsuarioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { perfil, setorId } = parsed.data;

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ id: string; perfil: string; setor_id: string | null }>(
          "SELECT id, perfil, setor_id FROM Usuario WHERE id = @id"
        );
      const usuario = atual.recordset[0];
      if (!usuario) {
        return reply.status(404).send({ erro: "Usuário não encontrado." });
      }

      const setorFinal = perfil === "admin" ? null : (setorId ?? usuario.setor_id);
      if (perfil !== "admin" && !setorFinal) {
        return reply
          .status(422)
          .send({ erro: "setorId é obrigatório para os perfis gestor_setor e colaborador." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("perfil", sql.VarChar, perfil)
          .input("setor_id", sql.UniqueIdentifier, setorFinal)
          .query<{ id: string; nome: string; email: string; perfil: string; setor_id: string | null }>(
            `UPDATE Usuario SET perfil = @perfil, setor_id = @setor_id
             OUTPUT INSERTED.id, INSERTED.nome, INSERTED.email, INSERTED.perfil, INSERTED.setor_id
             WHERE id = @id`
          );

        const atualizado = atualizacao.recordset[0];
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("acao", sql.VarChar, "alterar_perfil_usuario")
          .input("entidade_id", sql.UniqueIdentifier, id)
          .input(
            "detalhes",
            sql.NVarChar,
            JSON.stringify({ perfilAnterior: usuario.perfil, perfilNovo: perfil, setorId: setorFinal })
          )
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, @acao, 'Usuario', @entidade_id, @detalhes)`
          );

        await transaction.commit();
        return reply.status(200).send({
          id: atualizado.id,
          nome: atualizado.nome,
          email: atualizado.email,
          perfil: atualizado.perfil,
          setorId: atualizado.setor_id,
        });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );
}
