import type { FastifyInstance } from "fastify";
import {
  atualizarPerfilUsuarioSchema,
  atualizarStatusUsuarioSchema,
  criarUsuarioSchema,
  editarUsuarioSchema,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { calcularExpiracaoCodigo, gerarCodigoVerificacao, hashPassword } from "../utils/password.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateCodigoVerificacao } from "../services/email.service.js";

interface UsuarioRow {
  id: string;
  nome: string;
  email: string;
  perfil: string;
  setor_id: string | null;
  setor_nome: string | null;
  ativo: boolean;
  email_verificado: boolean;
  criado_em: Date;
  ultimo_login: Date | null;
}

const SELECT_USUARIO = `
  u.id, u.nome, u.email, u.perfil, u.setor_id, s.nome AS setor_nome,
  u.ativo, u.email_verificado, u.criado_em, u.ultimo_login`;
const FROM_USUARIO = "FROM Usuario u LEFT JOIN Setor s ON s.id = u.setor_id";

function mapUsuario(row: UsuarioRow) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    perfil: row.perfil,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    ativo: row.ativo,
    emailVerificado: row.email_verificado,
    criadoEm: row.criado_em,
    ultimoLogin: row.ultimo_login,
  };
}

async function registrarAuditoriaUsuario(
  transaction: sql.Transaction,
  usuarioId: string,
  acao: string,
  entidadeId: string,
  detalhes: Record<string, unknown>
): Promise<void> {
  await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("acao", sql.VarChar, acao)
    .input("entidade_id", sql.UniqueIdentifier, entidadeId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, 'Usuario', @entidade_id, @detalhes)`
    );
}

// RF-USR-01..05 (S12): administração completa de usuários. A promoção/rebaixamento de
// perfil (RF-USR-05) já existia desde S7 como mecanismo provisório — mantida como rota
// própria (PATCH /:id/perfil), agora complementada pelo CRUD completo abaixo.
export async function usuariosRoutes(app: FastifyInstance): Promise<void> {
  // RF-USR-02: listar/buscar/filtrar por setor, perfil e status.
  app.get(
    "/api/v1/usuarios",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { q, setor, perfil, status } = request.query as {
        q?: string;
        setor?: string;
        perfil?: string;
        status?: string;
      };
      const pool = await getPool();
      const dbRequest = pool.request();

      let where = "WHERE 1=1";
      if (q) {
        dbRequest.input("q", sql.NVarChar, `%${q}%`);
        where += " AND (u.nome LIKE @q OR u.email LIKE @q)";
      }
      if (setor) {
        dbRequest.input("setor_id", sql.UniqueIdentifier, setor);
        where += " AND u.setor_id = @setor_id";
      }
      if (perfil) {
        dbRequest.input("perfil", sql.VarChar, perfil);
        where += " AND u.perfil = @perfil";
      }
      if (status) {
        dbRequest.input("ativo", sql.Bit, status === "ativo");
        where += " AND u.ativo = @ativo";
      }

      const result = await dbRequest.query<UsuarioRow>(
        `SELECT ${SELECT_USUARIO} ${FROM_USUARIO} ${where} ORDER BY u.nome`
      );
      return reply.status(200).send(result.recordset.map(mapUsuario));
    }
  );

  // RF-USR-01: cadastrar usuário — nasce inativo quanto a email_verificado (ativo=1,
  // email_verificado=0) e recebe um código de ativação por e-mail, mesmo fluxo de
  // CodigoVerificacao usado em auth.ts (S1), aqui disparado pelo Admin em vez do
  // próprio usuário se auto-cadastrando.
  app.post(
    "/api/v1/usuarios",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarUsuarioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, email, perfil, setorId } = parsed.data;

      if (perfil !== "admin" && !setorId) {
        return reply
          .status(422)
          .send({ erro: "setorId é obrigatório para os perfis gestor_setor e colaborador." });
      }

      const pool = await getPool();
      const existente = await pool
        .request()
        .input("email", sql.NVarChar, email)
        .query("SELECT id FROM Usuario WHERE email = @email");
      if (existente.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe um usuário com este e-mail." });
      }

      const senhaPlaceholder = await hashPassword(gerarCodigoVerificacao() + gerarCodigoVerificacao());
      const codigo = gerarCodigoVerificacao();
      const expiraEm = calcularExpiracaoCodigo();
      const setorFinal = perfil === "admin" ? null : setorId ?? null;

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("nome", sql.NVarChar, nome)
          .input("email", sql.NVarChar, email)
          .input("senha_hash", sql.VarChar, senhaPlaceholder)
          .input("perfil", sql.VarChar, perfil)
          .input("setor_id", sql.UniqueIdentifier, setorFinal)
          .query<{ id: string }>(
            `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
             OUTPUT INSERTED.id
             VALUES (@nome, @email, @senha_hash, @perfil, @setor_id, 1, 0)`
          );
        const novoId = insercao.recordset[0].id;

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, novoId)
          .input("codigo", sql.Char(6), codigo)
          .input("tipo", sql.VarChar, "ativacao_conta")
          .input("expira_em", sql.DateTime2, expiraEm)
          .query(
            `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
             VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
          );

        await registrarAuditoriaUsuario(transaction, request.usuario!.sub, "criar_usuario", novoId, {
          nome,
          email,
          perfil,
          setorId: setorFinal,
        });

        await transaction.commit();

        const { assunto, corpoHtml } = templateCodigoVerificacao(codigo, "ativacao_conta");
        await enfileirarEmail({ destinatario: email, assunto, corpoHtml });

        const completo = await pool
          .request()
          .input("id", sql.UniqueIdentifier, novoId)
          .query<UsuarioRow>(`SELECT ${SELECT_USUARIO} ${FROM_USUARIO} WHERE u.id = @id`);
        return reply.status(201).send(mapUsuario(completo.recordset[0]));
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && (sqlErr.number === 2601 || sqlErr.number === 2627)) {
          return reply.status(409).send({ erro: "Já existe um usuário com este e-mail." });
        }
        throw err;
      }
    }
  );

  // RF-USR-01 (edição): nome/e-mail/setor. Perfil é alterado via PATCH /:id/perfil (RF-USR-05).
  app.patch(
    "/api/v1/usuarios/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = editarUsuarioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, email, setorId } = parsed.data;

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ perfil: string }>("SELECT perfil FROM Usuario WHERE id = @id");
      const usuario = atual.recordset[0];
      if (!usuario) {
        return reply.status(404).send({ erro: "Usuário não encontrado." });
      }

      if (usuario.perfil !== "admin" && !setorId) {
        return reply
          .status(422)
          .send({ erro: "setorId é obrigatório para os perfis gestor_setor e colaborador." });
      }

      const duplicado = await pool
        .request()
        .input("email", sql.NVarChar, email)
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Usuario WHERE email = @email AND id <> @id");
      if (duplicado.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe um usuário com este e-mail." });
      }

      const setorFinal = usuario.perfil === "admin" ? null : setorId ?? null;
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("nome", sql.NVarChar, nome)
          .input("email", sql.NVarChar, email)
          .input("setor_id", sql.UniqueIdentifier, setorFinal)
          .query(
            `UPDATE Usuario SET nome = @nome, email = @email, setor_id = @setor_id WHERE id = @id`
          );
        await registrarAuditoriaUsuario(transaction, request.usuario!.sub, "editar_usuario", id, {
          nome,
          email,
          setorId: setorFinal,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && (sqlErr.number === 2601 || sqlErr.number === 2627)) {
          return reply.status(409).send({ erro: "Já existe um usuário com este e-mail." });
        }
        throw err;
      }

      const completo = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<UsuarioRow>(`SELECT ${SELECT_USUARIO} ${FROM_USUARIO} WHERE u.id = @id`);
      return reply.status(200).send(mapUsuario(completo.recordset[0]));
    }
  );

  // RF-USR-03: ativar/desativar (soft delete — preserva histórico de reservas, nunca
  // exclui a linha de Usuario).
  app.patch(
    "/api/v1/usuarios/:id/status",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarStatusUsuarioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { ativo } = parsed.data;

      if (id === request.usuario!.sub && !ativo) {
        return reply.status(409).send({ erro: "Você não pode desativar a própria conta." });
      }

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ ativo: boolean }>("SELECT ativo FROM Usuario WHERE id = @id");
      if (!atual.recordset[0]) {
        return reply.status(404).send({ erro: "Usuário não encontrado." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("ativo", sql.Bit, ativo)
          .query("UPDATE Usuario SET ativo = @ativo WHERE id = @id");
        await registrarAuditoriaUsuario(transaction, request.usuario!.sub, "alterar_status_usuario", id, {
          ativoAnterior: atual.recordset[0].ativo,
          ativoNovo: ativo,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      const completo = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<UsuarioRow>(`SELECT ${SELECT_USUARIO} ${FROM_USUARIO} WHERE u.id = @id`);
      return reply.status(200).send(mapUsuario(completo.recordset[0]));
    }
  );

  // RF-USR-04: reenviar código de ativação (conta ainda não ativada) ou forçar
  // redefinição de senha (conta já ativa) — mesma infraestrutura de CodigoVerificacao
  // usada em auth.ts (S1), disparada pelo Admin em vez do próprio usuário.
  app.post(
    "/api/v1/usuarios/:id/reenviar-codigo",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = await getPool();
      const usuarioResult = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ email: string; email_verificado: boolean; ativo: boolean }>(
          "SELECT email, email_verificado, ativo FROM Usuario WHERE id = @id"
        );
      const usuario = usuarioResult.recordset[0];
      if (!usuario) {
        return reply.status(404).send({ erro: "Usuário não encontrado." });
      }
      if (!usuario.ativo) {
        return reply.status(409).send({ erro: "Usuário desativado — reative-o antes de reenviar o código." });
      }

      const tipo = usuario.email_verificado ? "reset_senha" : "ativacao_conta";
      const codigo = gerarCodigoVerificacao();
      const expiraEm = calcularExpiracaoCodigo();

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, id)
          .input("codigo", sql.Char(6), codigo)
          .input("tipo", sql.VarChar, tipo)
          .input("expira_em", sql.DateTime2, expiraEm)
          .query(
            `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
             VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
          );
        await registrarAuditoriaUsuario(transaction, request.usuario!.sub, "reenviar_codigo_usuario", id, { tipo });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      const { assunto, corpoHtml } = templateCodigoVerificacao(codigo, tipo);
      await enfileirarEmail({ destinatario: usuario.email, assunto, corpoHtml });

      return reply.status(200).send({ mensagem: "Código reenviado com sucesso.", tipo });
    }
  );

  // RF-USR-05 (S7) — mecanismo original de promoção/rebaixamento de perfil, mantido
  // intacto; a UI completa (S12) chama esta mesma rota ao lado do CRUD acima.
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
        await registrarAuditoriaUsuario(transaction, request.usuario!.sub, "alterar_perfil_usuario", id, {
          perfilAnterior: usuario.perfil,
          perfilNovo: perfil,
          setorId: setorFinal,
        });

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
