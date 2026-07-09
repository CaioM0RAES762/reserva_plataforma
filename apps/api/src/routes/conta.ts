import type { FastifyInstance } from "fastify";
import { trocarSenhaSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { autenticar } from "../middlewares/rbac.js";

export async function contaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/conta", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, request.usuario!.sub)
      .query(
        "SELECT id, nome, email, perfil, setor_id, ultimo_login FROM Usuario WHERE id = @id"
      );
    const usuario = result.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }
    return reply.status(200).send({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      setorId: usuario.setor_id,
      ultimoLogin: usuario.ultimo_login,
    });
  });

  app.patch("/api/v1/conta/senha", { preHandler: autenticar }, async (request, reply) => {
    const parsed = trocarSenhaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { senhaAtual, novaSenha } = parsed.data;

    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, request.usuario!.sub)
      .query("SELECT senha_hash FROM Usuario WHERE id = @id");

    const usuario = result.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }

    const senhaValida = await verifyPassword(senhaAtual, usuario.senha_hash);
    if (!senhaValida) {
      return reply.status(401).send({ erro: "Senha atual incorreta." });
    }

    const novoHash = await hashPassword(novaSenha);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("senha_hash", sql.VarChar, novoHash)
        .query("UPDATE Usuario SET senha_hash = @senha_hash WHERE id = @id");

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("acao", sql.VarChar, "trocar_senha")
        .input("entidade", sql.VarChar, "Usuario")
        .input("entidade_id", sql.UniqueIdentifier, request.usuario!.sub)
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, NULL)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    return reply.status(200).send({ mensagem: "Senha alterada com sucesso." });
  });
}
