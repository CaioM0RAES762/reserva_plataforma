import type { FastifyInstance } from "fastify";
import {
  atualizarStatusPlataformaSchema,
  criarPlataformaSchema,
  editarPlataformaSchema,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { normalizarCodigoPlataforma } from "../services/plataforma.service.js";

const CONFLITO_UNIQUE_SQL_ERROS = new Set([2601, 2627]);

interface PlataformaRow {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  capacidade: number | null;
  status: string;
  observacoes: string | null;
  criado_em: Date;
  atualizado_em: Date;
}

function mapPlataforma(row: PlataformaRow) {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    localizacao: row.localizacao,
    capacidade: row.capacidade,
    status: row.status,
    observacoes: row.observacoes,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const SELECT_COLUNAS =
  "id, codigo, nome, localizacao, capacidade, status, observacoes, criado_em, atualizado_em";

async function registrarAuditoria(
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
    .input("entidade", sql.VarChar, "Plataforma")
    .input("entidade_id", sql.UniqueIdentifier, entidadeId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
    );
}

export async function plataformasRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/plataformas", { preHandler: autenticar }, async (request, reply) => {
    const { q, status } = request.query as { q?: string; status?: string };
    const pool = await getPool();
    const dbRequest = pool.request();

    let where = "WHERE 1=1";
    if (q) {
      dbRequest.input("q", sql.NVarChar, `%${q}%`);
      where += " AND (nome LIKE @q OR codigo LIKE @q OR localizacao LIKE @q)";
    }
    if (status) {
      dbRequest.input("status", sql.VarChar, status);
      where += " AND status = @status";
    }

    const result = await dbRequest.query<PlataformaRow>(
      `SELECT ${SELECT_COLUNAS} FROM Plataforma ${where} ORDER BY codigo`
    );
    return reply.status(200).send(result.recordset.map(mapPlataforma));
  });

  app.post(
    "/api/v1/plataformas",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const codigo = normalizarCodigoPlataforma(parsed.data.codigo);
      const pool = await getPool();

      const existente = await pool
        .request()
        .input("codigo", sql.VarChar, codigo)
        .query("SELECT id FROM Plataforma WHERE codigo = @codigo");
      if (existente.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("codigo", sql.VarChar, codigo)
          .input("nome", sql.NVarChar, parsed.data.nome)
          .input("localizacao", sql.NVarChar, parsed.data.localizacao ?? null)
          .input("capacidade", sql.Int, parsed.data.capacidade ?? null)
          .input("observacoes", sql.NVarChar, parsed.data.observacoes ?? null)
          .query<PlataformaRow>(
            `INSERT INTO Plataforma (codigo, nome, localizacao, capacidade, observacoes)
             OUTPUT ${SELECT_COLUNAS.split(", ")
               .map((coluna) => `INSERTED.${coluna}`)
               .join(", ")}
             VALUES (@codigo, @nome, @localizacao, @capacidade, @observacoes)`
          );

        const nova = insercao.recordset[0];
        await registrarAuditoria(transaction, request.usuario!.sub, "criar_plataforma", nova.id, {
          codigo: nova.codigo,
          nome: nova.nome,
        });

        await transaction.commit();
        return reply.status(201).send(mapPlataforma(nova));
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
        }
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/plataformas/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = editarPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const codigo = normalizarCodigoPlataforma(parsed.data.codigo);
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Plataforma WHERE id = @id");
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }

      const duplicado = await pool
        .request()
        .input("codigo", sql.VarChar, codigo)
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Plataforma WHERE codigo = @codigo AND id <> @id");
      if (duplicado.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("codigo", sql.VarChar, codigo)
          .input("nome", sql.NVarChar, parsed.data.nome)
          .input("localizacao", sql.NVarChar, parsed.data.localizacao ?? null)
          .input("capacidade", sql.Int, parsed.data.capacidade ?? null)
          .input("observacoes", sql.NVarChar, parsed.data.observacoes ?? null)
          .query<PlataformaRow>(
            `UPDATE Plataforma SET
               codigo = @codigo, nome = @nome, localizacao = @localizacao,
               capacidade = @capacidade, observacoes = @observacoes, atualizado_em = SYSUTCDATETIME()
             OUTPUT ${SELECT_COLUNAS.split(", ")
               .map((coluna) => `INSERTED.${coluna}`)
               .join(", ")}
             WHERE id = @id`
          );

        const editada = atualizacao.recordset[0];
        await registrarAuditoria(transaction, request.usuario!.sub, "editar_plataforma", id, {
          codigo: editada.codigo,
          nome: editada.nome,
        });

        await transaction.commit();
        return reply.status(200).send(mapPlataforma(editada));
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/v1/plataformas/:id/status",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarStatusPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { status } = parsed.data;
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id, status FROM Plataforma WHERE id = @id");
      const plataforma = atual.recordset[0];
      if (!plataforma) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }

      if (status === "inativa") {
        // RN-PLAT-02: só pode desativar se não houver reservas pendente/agendada/em_uso.
        // Validação estrutural desde já — Reserva ainda não tem rotas de escrita até S3,
        // mas a checagem aqui evita reintroduzir a regra numa migration futura.
        const reservasAtivas = await pool
          .request()
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .query(
            `SELECT TOP 1 id FROM Reserva
             WHERE plataforma_id = @plataforma_id AND status IN ('pendente','agendada','em_uso')`
          );
        if (reservasAtivas.recordset.length > 0) {
          return reply
            .status(409)
            .send({ erro: "Existem reservas ativas para esta plataforma. Cancele-as antes de desativar." });
        }
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("status", sql.VarChar, status)
          .query<PlataformaRow>(
            `UPDATE Plataforma SET status = @status, atualizado_em = SYSUTCDATETIME()
             OUTPUT ${SELECT_COLUNAS.split(", ")
               .map((coluna) => `INSERTED.${coluna}`)
               .join(", ")}
             WHERE id = @id`
          );

        const atualizada = atualizacao.recordset[0];
        await registrarAuditoria(transaction, request.usuario!.sub, "alterar_status_plataforma", id, {
          statusAnterior: plataforma.status,
          statusNovo: status,
        });

        await transaction.commit();
        return reply.status(200).send(mapPlataforma(atualizada));
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );
}
