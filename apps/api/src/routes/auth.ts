import type { FastifyInstance } from "fastify";
import {
  ativarContaSchema,
  loginSchema,
  recuperarSenhaConfirmarSchema,
  recuperarSenhaSolicitarSchema,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import {
  calcularExpiracaoCodigo,
  codigoExpirado,
  gerarCodigoVerificacao,
  hashPassword,
  verifyPassword,
} from "../utils/password.js";
import { assinarToken } from "../utils/jwt.js";
import { checarRateLimitLogin, limparRateLimitLogin } from "../services/rateLimit.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateCodigoVerificacao } from "../services/email.service.js";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/logout", async (_request, reply) => {
    reply.clearCookie("token", { path: "/" });
    return reply.status(200).send({ mensagem: "Sessão encerrada." });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, senha } = parsed.data;

    const rateLimit = await checarRateLimitLogin(email);
    if (!rateLimit.permitido) {
      return reply.status(429).send({
        erro: "Muitas tentativas de login. Tente novamente em alguns minutos.",
      });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query(
        "SELECT id, nome, email, senha_hash, perfil, setor_id, ativo, email_verificado FROM Usuario WHERE email = @email"
      );

    const usuario = result.recordset[0];
    if (!usuario) {
      return reply.status(401).send({ erro: "Credenciais inválidas." });
    }
    if (!usuario.ativo) {
      return reply.status(403).send({ erro: "Conta desativada. Contate o administrador." });
    }
    if (!usuario.email_verificado) {
      return reply.status(403).send({ erro: "Conta não ativada. Verifique o código enviado por e-mail." });
    }

    const senhaValida = await verifyPassword(senha, usuario.senha_hash);
    if (!senhaValida) {
      return reply.status(401).send({ erro: "Credenciais inválidas." });
    }

    await limparRateLimitLogin(email);

    const token = assinarToken({
      sub: usuario.id,
      email: usuario.email,
      perfil: usuario.perfil,
      setorId: usuario.setor_id,
    });

    await pool
      .request()
      .input("id", sql.UniqueIdentifier, usuario.id)
      .query("UPDATE Usuario SET ultimo_login = SYSUTCDATETIME() WHERE id = @id");

    reply.setCookie("token", token, COOKIE_OPTIONS);
    return reply.status(200).send({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        setorId: usuario.setor_id,
      },
    });
  });

  app.post("/api/v1/auth/ativar-conta", async (request, reply) => {
    const parsed = ativarContaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, codigo, senha } = parsed.data;

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query("SELECT id FROM Usuario WHERE email = @email");

    const usuario = usuarioResult.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }

    const codigoResult = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuario.id)
      .input("tipo", sql.VarChar, "ativacao_conta")
      .query(
        `SELECT TOP 1 id, codigo, expira_em, utilizado FROM CodigoVerificacao
         WHERE usuario_id = @usuario_id AND tipo = @tipo
         ORDER BY criado_em DESC`
      );

    const codigoRegistro = codigoResult.recordset[0];
    if (!codigoRegistro || codigoRegistro.codigo !== codigo) {
      return reply.status(400).send({ erro: "Código de verificação inválido." });
    }
    if (codigoRegistro.utilizado) {
      return reply.status(400).send({ erro: "Código já utilizado." });
    }
    if (codigoExpirado(new Date(codigoRegistro.expira_em))) {
      return reply.status(400).send({ erro: "Código expirado." });
    }

    const senhaHash = await hashPassword(senha);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, usuario.id)
        .input("senha_hash", sql.VarChar, senhaHash)
        .query(
          "UPDATE Usuario SET senha_hash = @senha_hash, email_verificado = 1 WHERE id = @id"
        );

      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, codigoRegistro.id)
        .query("UPDATE CodigoVerificacao SET utilizado = 1 WHERE id = @id");

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, usuario.id)
        .input("acao", sql.VarChar, "ativar_conta")
        .input("entidade", sql.VarChar, "Usuario")
        .input("entidade_id", sql.UniqueIdentifier, usuario.id)
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, NULL)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    return reply.status(200).send({ mensagem: "Conta ativada com sucesso." });
  });

  app.post("/api/v1/auth/recuperar-senha", async (request, reply) => {
    const parsed = recuperarSenhaSolicitarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email } = parsed.data;

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query("SELECT id FROM Usuario WHERE email = @email");

    const usuario = usuarioResult.recordset[0];
    // Resposta genérica sempre 200, mesmo se o e-mail não existir, para não vazar quais
    // e-mails estão cadastrados (enumeração de contas).
    if (!usuario) {
      return reply.status(200).send({ mensagem: "Se o e-mail existir, um código foi enviado." });
    }

    const codigo = gerarCodigoVerificacao();
    const expiraEm = calcularExpiracaoCodigo();

    await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuario.id)
      .input("codigo", sql.Char(6), codigo)
      .input("tipo", sql.VarChar, "reset_senha")
      .input("expira_em", sql.DateTime2, expiraEm)
      .query(
        `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
         VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
      );

    const { assunto, corpoHtml } = templateCodigoVerificacao(codigo, "reset_senha");
    await enfileirarEmail({ destinatario: email, assunto, corpoHtml });

    return reply.status(200).send({ mensagem: "Se o e-mail existir, um código foi enviado." });
  });

  app.post("/api/v1/auth/recuperar-senha/confirmar", async (request, reply) => {
    const parsed = recuperarSenhaConfirmarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, codigo, novaSenha } = parsed.data;

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query("SELECT id FROM Usuario WHERE email = @email");

    const usuario = usuarioResult.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }

    const codigoResult = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuario.id)
      .input("tipo", sql.VarChar, "reset_senha")
      .query(
        `SELECT TOP 1 id, codigo, expira_em, utilizado FROM CodigoVerificacao
         WHERE usuario_id = @usuario_id AND tipo = @tipo
         ORDER BY criado_em DESC`
      );

    const codigoRegistro = codigoResult.recordset[0];
    if (!codigoRegistro || codigoRegistro.codigo !== codigo) {
      return reply.status(400).send({ erro: "Código de verificação inválido." });
    }
    if (codigoRegistro.utilizado) {
      return reply.status(400).send({ erro: "Código já utilizado." });
    }
    if (codigoExpirado(new Date(codigoRegistro.expira_em))) {
      return reply.status(400).send({ erro: "Código expirado." });
    }

    const senhaHash = await hashPassword(novaSenha);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, usuario.id)
        .input("senha_hash", sql.VarChar, senhaHash)
        .query("UPDATE Usuario SET senha_hash = @senha_hash WHERE id = @id");

      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, codigoRegistro.id)
        .query("UPDATE CodigoVerificacao SET utilizado = 1 WHERE id = @id");

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, usuario.id)
        .input("acao", sql.VarChar, "redefinir_senha")
        .input("entidade", sql.VarChar, "Usuario")
        .input("entidade_id", sql.UniqueIdentifier, usuario.id)
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, NULL)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    return reply.status(200).send({ mensagem: "Senha redefinida com sucesso." });
  });
}
