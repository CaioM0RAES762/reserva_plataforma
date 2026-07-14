import type { FastifyInstance } from "fastify";
import { atualizarStatusSetorSchema, criarSetorSchema, editarSetorSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";

const CONFLITO_UNIQUE_SQL_ERROS = new Set([2601, 2627]);

interface SetorRow {
  id: string;
  nome: string;
  cor_hex: string;
}

interface SetorAdminRow extends SetorRow {
  ativo: boolean;
}

async function registrarAuditoriaSetor(
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
       VALUES (@usuario_id, @acao, 'Setor', @entidade_id, @detalhes)`
    );
}

// RF-SET-01/02 (S12): CRUD completo de setores. GET /setores (S1, somente leitura,
// filtrado a ativo=1) permanece intacto — usado pela legenda do Calendário e pelo
// formulário de Nova Reserva, que só devem oferecer setores ativos.
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

  // RF-SET-02/S12: listagem administrativa (Admin), incluindo setores inativos —
  // usada pela tela "Setores", nunca pelo formulário de reserva.
  app.get(
    "/api/v1/setores/admin",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (_request, reply) => {
      const pool = await getPool();
      const result = await pool
        .request()
        .query<SetorAdminRow>("SELECT id, nome, cor_hex, ativo FROM Setor ORDER BY nome");
      return reply.status(200).send(
        result.recordset.map((row) => ({ id: row.id, nome: row.nome, corHex: row.cor_hex, ativo: row.ativo }))
      );
    }
  );

  app.post(
    "/api/v1/setores",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarSetorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, corHex } = parsed.data;
      const pool = await getPool();

      const existente = await pool
        .request()
        .input("nome", sql.NVarChar, nome)
        .query("SELECT id FROM Setor WHERE nome = @nome");
      if (existente.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe um setor com este nome." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("nome", sql.NVarChar, nome)
          .input("cor_hex", sql.Char(7), corHex)
          .query<SetorAdminRow>(
            `INSERT INTO Setor (nome, cor_hex)
             OUTPUT INSERTED.id, INSERTED.nome, INSERTED.cor_hex, INSERTED.ativo
             VALUES (@nome, @cor_hex)`
          );
        const novo = insercao.recordset[0];
        await registrarAuditoriaSetor(transaction, request.usuario!.sub, "criar_setor", novo.id, { nome, corHex });
        await transaction.commit();
        return reply
          .status(201)
          .send({ id: novo.id, nome: novo.nome, corHex: novo.cor_hex, ativo: novo.ativo });
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe um setor com este nome." });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/v1/setores/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = editarSetorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, corHex } = parsed.data;
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Setor WHERE id = @id");
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Setor não encontrado." });
      }

      const duplicado = await pool
        .request()
        .input("nome", sql.NVarChar, nome)
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Setor WHERE nome = @nome AND id <> @id");
      if (duplicado.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe um setor com este nome." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("nome", sql.NVarChar, nome)
          .input("cor_hex", sql.Char(7), corHex)
          .query<SetorAdminRow>(
            `UPDATE Setor SET nome = @nome, cor_hex = @cor_hex
             OUTPUT INSERTED.id, INSERTED.nome, INSERTED.cor_hex, INSERTED.ativo
             WHERE id = @id`
          );
        const editado = atualizacao.recordset[0];
        await registrarAuditoriaSetor(transaction, request.usuario!.sub, "editar_setor", id, { nome, corHex });
        await transaction.commit();
        return reply
          .status(200)
          .send({ id: editado.id, nome: editado.nome, corHex: editado.cor_hex, ativo: editado.ativo });
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe um setor com este nome." });
        }
        throw err;
      }
    }
  );

  // RF-SET-02/RN-USR-02: bloquear desativação de setor com usuário ativo vinculado.
  app.patch(
    "/api/v1/setores/:id/status",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarStatusSetorSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { ativo } = parsed.data;
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ ativo: boolean }>("SELECT ativo FROM Setor WHERE id = @id");
      const setor = atual.recordset[0];
      if (!setor) {
        return reply.status(404).send({ erro: "Setor não encontrado." });
      }

      if (!ativo) {
        // RN-USR-02: setor não pode ser desativado enquanto houver usuário ativo vinculado.
        const usuariosAtivos = await pool
          .request()
          .input("setor_id", sql.UniqueIdentifier, id)
          .query("SELECT TOP 1 id FROM Usuario WHERE setor_id = @setor_id AND ativo = 1");
        if (usuariosAtivos.recordset.length > 0) {
          return reply.status(409).send({
            erro:
              "Existem usuários ativos vinculados a este setor. Desative-os (ou transfira-os para outro setor) antes de desativar o setor (RN-USR-02).",
          });
        }
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("ativo", sql.Bit, ativo)
          .query<SetorAdminRow>(
            `UPDATE Setor SET ativo = @ativo
             OUTPUT INSERTED.id, INSERTED.nome, INSERTED.cor_hex, INSERTED.ativo
             WHERE id = @id`
          );
        const atualizado = atualizacao.recordset[0];
        await registrarAuditoriaSetor(transaction, request.usuario!.sub, "alterar_status_setor", id, {
          ativoAnterior: setor.ativo,
          ativoNovo: ativo,
        });
        await transaction.commit();
        return reply
          .status(200)
          .send({ id: atualizado.id, nome: atualizado.nome, corHex: atualizado.cor_hex, ativo: atualizado.ativo });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );
}
