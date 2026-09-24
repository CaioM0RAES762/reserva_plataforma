import type { FastifyInstance } from "fastify";
import { senhaSchema, trocarSenhaPayloadSchema } from "@plataformares/shared";
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
        `SELECT u.id, u.nome, u.email, u.telefone, u.perfil, u.setor_id, s.nome AS setor_nome,
                u.senha_provisoria, u.ultimo_login
         FROM Usuario u LEFT JOIN Setor s ON s.id = u.setor_id
         WHERE u.id = @id`
      );
    const usuario = result.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }
    return reply.status(200).send({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      telefone: usuario.telefone,
      perfil: usuario.perfil,
      setorId: usuario.setor_id,
      setorNome: usuario.setor_nome,
      senhaProvisoria: !!usuario.senha_provisoria,
      ultimoLogin: usuario.ultimo_login,
    });
  });

  app.patch("/api/v1/conta/senha", { preHandler: autenticar }, async (request, reply) => {
    const parsed = trocarSenhaPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        erro: parsed.error.issues[0]?.message ?? "Dados inválidos.",
        detalhes: parsed.error.flatten(),
      });
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

    if (novaSenha === senhaAtual) {
      return reply.status(400).send({ erro: "A nova senha deve ser diferente da senha atual." });
    }

    const novaSenhaValidada = senhaSchema.safeParse(novaSenha);
    if (!novaSenhaValidada.success) {
      return reply.status(422).send({
        erro:
          novaSenhaValidada.error.issues[0]?.message ??
          "A nova senha não atende aos requisitos de segurança.",
        detalhes: novaSenhaValidada.error.flatten(),
      });
    }

    const novoHash = await hashPassword(novaSenhaValidada.data);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      // Trocar a senha (por escolha própria, aqui) sempre encerra o estado de "senha
      // provisória" — é exatamente o que essa troca deveria fazer, mesmo que o usuário não
      // tenha vindo do fluxo de "Novo Usuário" (ex.: já era 0 e continua 0).
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("senha_hash", sql.VarChar, novoHash)
        .query("UPDATE Usuario SET senha_hash = @senha_hash, senha_provisoria = 0 WHERE id = @id");

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
