import type { FastifyInstance } from "fastify";
import { criarCategoriaEquipamentoSchema, editarCategoriaEquipamentoSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { gerarCodigoCategoria } from "../services/plataforma.service.js";

/* Categorias de equipamento (migration 0025). Leitura para qualquer usuário autenticado (o
 * formulário de plataforma e a Frota precisam dos nomes); escrita SÓ do Admin. Não há
 * exclusão: categoria em uso é desativada — some das opções de novos cadastros e continua
 * exibida corretamente nas plataformas que já a usam. */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFLITO_UNIQUE_SQL_ERROS = new Set([2601, 2627]);
const MENSAGEM_NOME_DUPLICADO = "Já existe uma categoria com este nome.";

interface CategoriaRow {
  id: string;
  codigo: string;
  nome: string;
  ativo: boolean;
  em_uso: number;
}

const SELECT_CATEGORIAS = `
  SELECT c.id, c.codigo, c.nome, c.ativo,
         (SELECT COUNT(*) FROM Plataforma p WHERE p.categoria = c.codigo) AS em_uso
  FROM CategoriaEquipamento c`;

function mapCategoria(row: CategoriaRow) {
  return { id: row.id.toLowerCase(), codigo: row.codigo, nome: row.nome, ativo: row.ativo, emUso: row.em_uso };
}

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
    .input("entidade", sql.VarChar, "CategoriaEquipamento")
    .input("entidade_id", sql.UniqueIdentifier, entidadeId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
    );
}

export async function categoriasEquipamentoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/categorias-equipamento", { preHandler: autenticar }, async (_request, reply) => {
    const pool = await getPool();
    const result = await pool.request().query<CategoriaRow>(`${SELECT_CATEGORIAS} ORDER BY c.ordem, c.nome`);
    return reply.status(200).send(result.recordset.map(mapCategoria));
  });

  app.post(
    "/api/v1/categorias-equipamento",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarCategoriaEquipamentoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos." });
      }
      const nome = parsed.data.nome;
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const existentes = await transaction
          .request()
          .query<{ codigo: string; nome: string }>(
            "SELECT codigo, nome FROM CategoriaEquipamento WITH (UPDLOCK, HOLDLOCK)"
          );
        if (existentes.recordset.some((c) => c.nome.localeCompare(nome, "pt-BR", { sensitivity: "accent" }) === 0)) {
          await transaction.rollback();
          return reply.status(409).send({ erro: MENSAGEM_NOME_DUPLICADO });
        }
        const codigo = gerarCodigoCategoria(nome, existentes.recordset.map((c) => c.codigo));
        const inserida = await transaction
          .request()
          .input("codigo", sql.VarChar, codigo)
          .input("nome", sql.NVarChar, nome)
          .query<{ id: string }>(
            `INSERT INTO CategoriaEquipamento (codigo, nome, ordem)
             OUTPUT INSERTED.id
             VALUES (@codigo, @nome, (SELECT ISNULL(MAX(ordem), 0) + 1 FROM CategoriaEquipamento))`
          );
        const id = inserida.recordset[0].id;
        await registrarAuditoria(transaction, request.usuario!.sub, "criar_categoria_equipamento", id, { nome, codigo });
        await transaction.commit();
        const completa = await pool
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<CategoriaRow>(`${SELECT_CATEGORIAS} WHERE c.id = @id`);
        return reply.status(201).send(mapCategoria(completa.recordset[0]));
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: MENSAGEM_NOME_DUPLICADO });
        }
        throw err;
      }
    }
  );

  // Exclusão DE FATO — só de categoria sem plataformas (FK_Plataforma_categoria). Em uso,
  // a regra continua sendo desativar: apagar exigiria reclassificar equipamentos às cegas.
  app.delete(
    "/api/v1/categorias-equipamento/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_REGEX.test(id)) return reply.status(404).send({ erro: "Categoria não encontrada." });
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atual = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ codigo: string; nome: string; em_uso: number }>(
            `SELECT c.codigo, c.nome,
                    (SELECT COUNT(*) FROM Plataforma p WITH (UPDLOCK, HOLDLOCK) WHERE p.categoria = c.codigo) AS em_uso
             FROM CategoriaEquipamento c WITH (UPDLOCK) WHERE c.id = @id`
          );
        const categoria = atual.recordset[0];
        if (!categoria) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Categoria não encontrada." });
        }
        if (categoria.em_uso > 0) {
          await transaction.rollback();
          return reply.status(409).send({
            erro: `Categoria em uso por ${categoria.em_uso} plataforma${categoria.em_uso > 1 ? "s" : ""} — desative-a em vez de excluir.`,
          });
        }
        await transaction.request().input("id", sql.UniqueIdentifier, id).query("DELETE FROM CategoriaEquipamento WHERE id = @id");
        await registrarAuditoria(transaction, request.usuario!.sub, "excluir_categoria_equipamento", id, {
          nome: categoria.nome,
          codigo: categoria.codigo,
        });
        await transaction.commit();
        return reply.status(204).send();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        // Uma plataforma gravada com a categoria no meio do caminho: a FK recusa o DELETE.
        if ((err as { number?: number }).number === 547) {
          return reply.status(409).send({ erro: "Categoria em uso — desative-a em vez de excluir." });
        }
        throw err;
      }
    }
  );

  // Renomear e/ou ativar/desativar. O código não muda: é o que as plataformas guardam.
  app.put(
    "/api/v1/categorias-equipamento/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_REGEX.test(id)) return reply.status(404).send({ erro: "Categoria não encontrada." });
      const parsed = editarCategoriaEquipamentoSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos." });
      }
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atual = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ codigo: string; nome: string; ativo: boolean }>(
            "SELECT codigo, nome, ativo FROM CategoriaEquipamento WITH (UPDLOCK) WHERE id = @id"
          );
        const categoria = atual.recordset[0];
        if (!categoria) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Categoria não encontrada." });
        }
        const nomeNovo = parsed.data.nome ?? categoria.nome;
        const ativoNovo = parsed.data.ativo ?? categoria.ativo;

        if (nomeNovo !== categoria.nome) {
          const duplicado = await transaction
            .request()
            .input("id", sql.UniqueIdentifier, id)
            .query<{ nome: string }>("SELECT nome FROM CategoriaEquipamento WHERE id <> @id");
          if (duplicado.recordset.some((c) => c.nome.localeCompare(nomeNovo, "pt-BR", { sensitivity: "accent" }) === 0)) {
            await transaction.rollback();
            return reply.status(409).send({ erro: MENSAGEM_NOME_DUPLICADO });
          }
        }

        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("nome", sql.NVarChar, nomeNovo)
          .input("ativo", sql.Bit, ativoNovo)
          .query(
            "UPDATE CategoriaEquipamento SET nome = @nome, ativo = @ativo, atualizado_em = SYSUTCDATETIME() WHERE id = @id"
          );

        if (nomeNovo !== categoria.nome) {
          await registrarAuditoria(transaction, request.usuario!.sub, "editar_categoria_equipamento", id, {
            nome: nomeNovo,
            codigo: categoria.codigo,
            nomeAnterior: categoria.nome,
            nomeNovo,
          });
        }
        if (ativoNovo !== categoria.ativo) {
          await registrarAuditoria(
            transaction,
            request.usuario!.sub,
            ativoNovo ? "ativar_categoria_equipamento" : "desativar_categoria_equipamento",
            id,
            { nome: nomeNovo, codigo: categoria.codigo }
          );
        }
        await transaction.commit();
        const completa = await pool
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<CategoriaRow>(`${SELECT_CATEGORIAS} WHERE c.id = @id`);
        return reply.status(200).send(mapCategoria(completa.recordset[0]));
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: MENSAGEM_NOME_DUPLICADO });
        }
        throw err;
      }
    }
  );
}
