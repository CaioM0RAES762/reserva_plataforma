import type { FastifyInstance } from "fastify";
import { adicionarResponsaveisPlataformaSchema, type PlataformaComResponsaveis } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";

// Gestores responsáveis por plataforma (migration 0030). Só o Admin atribui e remove; a
// atribuição concede ao Gestor a GESTÃO daquela plataforma (gestaoPlataforma.service) — nada
// além disso: nenhum acesso a usuários, configurações, categorias ou administração.
// Vale para qualquer recurso cadastrado como Plataforma, independentemente da categoria.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LinhaResponsavel {
  plataforma_id: string;
  gestor_id: string;
  nome: string;
  email: string;
  setor_nome: string | null;
  perfil: string;
  ativo: boolean;
  atribuido_em: Date;
  atribuido_por_nome: string | null;
}

type Executor = { request(): sql.Request };

async function buscarResponsaveis(executor: Executor, plataformaId?: string): Promise<Map<string, LinhaResponsavel[]>> {
  const req = executor.request();
  let where = "";
  if (plataformaId) {
    req.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
    where = "WHERE pr.plataforma_id = @plataforma_id";
  }
  const result = await req.query<LinhaResponsavel>(
    `SELECT pr.plataforma_id, pr.gestor_id, u.nome, u.email, s.nome AS setor_nome, u.perfil, u.ativo,
            pr.atribuido_em, ap.nome AS atribuido_por_nome
     FROM PlataformaResponsavel pr
     JOIN Usuario u ON u.id = pr.gestor_id
     LEFT JOIN Setor s ON s.id = u.setor_id
     LEFT JOIN Usuario ap ON ap.id = pr.atribuido_por_id
     ${where}
     ORDER BY u.nome`
  );
  const mapa = new Map<string, LinhaResponsavel[]>();
  for (const linha of result.recordset) {
    const chave = linha.plataforma_id.toLowerCase();
    mapa.set(chave, [...(mapa.get(chave) ?? []), linha]);
  }
  return mapa;
}

function mapResponsavel(l: LinhaResponsavel) {
  return {
    gestorId: l.gestor_id,
    nome: l.nome,
    email: l.email,
    setorNome: l.setor_nome,
    // A associação permanece, mas só concede acesso enquanto o usuário for Gestor ativo.
    concedeAcesso: l.ativo && l.perfil === "gestor_setor",
    atribuidoEm: l.atribuido_em.toISOString(),
    atribuidoPorNome: l.atribuido_por_nome,
  };
}

interface LinhaPlataforma {
  id: string;
  codigo: string;
  nome: string;
  categoria_nome: string | null;
  setor_id: string | null;
  setor_nome: string | null;
  status: string;
}

async function listar(executor: Executor, filtros: { q?: string; setor?: string; plataformaId?: string }) {
  const req = executor.request();
  let where = "WHERE 1=1";
  if (filtros.q) {
    req.input("q", sql.NVarChar, `%${filtros.q}%`);
    where += " AND (p.nome LIKE @q OR p.codigo LIKE @q)";
  }
  if (filtros.setor === "sem_setor") {
    where += " AND p.setor_id IS NULL";
  } else if (filtros.setor) {
    req.input("setor_id", sql.UniqueIdentifier, filtros.setor);
    where += " AND p.setor_id = @setor_id";
  }
  if (filtros.plataformaId) {
    req.input("plataforma_id", sql.UniqueIdentifier, filtros.plataformaId);
    where += " AND p.id = @plataforma_id";
  }
  const [plataformas, responsaveis] = await Promise.all([
    req.query<LinhaPlataforma>(
      `SELECT p.id, p.codigo, p.nome, cat.nome AS categoria_nome, p.setor_id, s.nome AS setor_nome, p.status
       FROM Plataforma p
       LEFT JOIN CategoriaEquipamento cat ON cat.codigo = p.categoria
       LEFT JOIN Setor s ON s.id = p.setor_id
       ${where}
       ORDER BY p.codigo`
    ),
    buscarResponsaveis(executor, filtros.plataformaId),
  ]);
  return plataformas.recordset.map<PlataformaComResponsaveis>((p) => ({
    plataformaId: p.id,
    codigo: p.codigo,
    nome: p.nome,
    categoriaNome: p.categoria_nome,
    setorId: p.setor_id,
    setorNome: p.setor_nome,
    status: p.status,
    responsaveis: (responsaveis.get(p.id.toLowerCase()) ?? []).map(mapResponsavel),
  }));
}

export async function responsaveisPlataformaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/plataformas-responsaveis",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { q, setor } = request.query as { q?: string; setor?: string };
      if (setor && setor !== "sem_setor" && !UUID_REGEX.test(setor)) {
        return reply.status(422).send({ erro: "Setor inválido." });
      }
      const pool = await getPool();
      return reply.status(200).send(await listar(pool, { q: q?.trim() || undefined, setor }));
    }
  );

  app.post(
    "/api/v1/plataformas/:id/responsaveis",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_REGEX.test(id)) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      const parsed = adicionarResponsaveisPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const gestorIds = [...new Set(parsed.data.gestorIds.map((g) => g.toLowerCase()))];
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        // Lock na plataforma: duas atribuições simultâneas serializam aqui.
        const plataforma = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ codigo: string; nome: string }>("SELECT codigo, nome FROM Plataforma WITH (UPDLOCK, ROWLOCK) WHERE id = @id");
        if (!plataforma.recordset[0]) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Plataforma não encontrada." });
        }

        // Só Gestor de Setor ATIVO pode ser responsável (Admin já tem acesso global).
        const consultaGestores = transaction.request();
        gestorIds.forEach((g, i) => consultaGestores.input(`g${i}`, sql.UniqueIdentifier, g));
        const gestores = await consultaGestores.query<{ id: string; nome: string; perfil: string; ativo: boolean }>(
          `SELECT id, nome, perfil, ativo FROM Usuario WHERE id IN (${gestorIds.map((_, i) => `@g${i}`).join(", ")})`
        );
        const invalidos = gestorIds.filter((g) => {
          const u = gestores.recordset.find((x) => x.id.toLowerCase() === g);
          return !u || !u.ativo || u.perfil !== "gestor_setor";
        });
        if (invalidos.length > 0) {
          await transaction.rollback();
          return reply.status(422).send({
            erro: "Só é possível atribuir usuários ativos com perfil Gestor de Setor.",
            detalhes: { formErrors: [], fieldErrors: { gestorIds: invalidos } },
          });
        }

        const anteriores = (await buscarResponsaveis(transaction, id)).get(id.toLowerCase()) ?? [];
        const jaAtribuidos = new Set(anteriores.map((r) => r.gestor_id.toLowerCase()));
        const novos = gestorIds.filter((g) => !jaAtribuidos.has(g));
        for (const gestorId of novos) {
          await transaction
            .request()
            .input("plataforma_id", sql.UniqueIdentifier, id)
            .input("gestor_id", sql.UniqueIdentifier, gestorId)
            .input("atribuido_por_id", sql.UniqueIdentifier, request.usuario!.sub)
            .query(
              `INSERT INTO PlataformaResponsavel (plataforma_id, gestor_id, atribuido_por_id)
               VALUES (@plataforma_id, @gestor_id, @atribuido_por_id)`
            );
        }
        if (novos.length > 0) {
          const nomePorId = new Map(gestores.recordset.map((g) => [g.id.toLowerCase(), g.nome]));
          const depois = [
            ...anteriores.map((r) => ({ id: r.gestor_id, nome: r.nome })),
            ...novos.map((g) => ({ id: g, nome: nomePorId.get(g) ?? "" })),
          ];
          await registrarAuditoriaResponsaveis(transaction, request.usuario!.sub, "atribuir_responsaveis_plataforma", id, {
            ...plataforma.recordset[0],
            adicionados: novos.map((g) => ({ id: g, nome: nomePorId.get(g) ?? "" })),
            responsaveisAnteriores: anteriores.map((r) => ({ id: r.gestor_id, nome: r.nome })),
            responsaveisNovos: depois,
          });
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
      const [item] = await listar(pool, { plataformaId: id });
      return reply.status(200).send(item);
    }
  );

  app.delete(
    "/api/v1/plataformas/:id/responsaveis/:gestorId",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id, gestorId } = request.params as { id: string; gestorId: string };
      if (!UUID_REGEX.test(id) || !UUID_REGEX.test(gestorId)) {
        return reply.status(404).send({ erro: "Responsável não encontrado." });
      }
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const plataforma = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ codigo: string; nome: string }>("SELECT codigo, nome FROM Plataforma WITH (UPDLOCK, ROWLOCK) WHERE id = @id");
        if (!plataforma.recordset[0]) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Plataforma não encontrada." });
        }
        const anteriores = (await buscarResponsaveis(transaction, id)).get(id.toLowerCase()) ?? [];
        const removido = anteriores.find((r) => r.gestor_id.toLowerCase() === gestorId.toLowerCase());
        if (!removido) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Este gestor não é responsável pela plataforma." });
        }
        await transaction
          .request()
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .input("gestor_id", sql.UniqueIdentifier, gestorId)
          .query("DELETE FROM PlataformaResponsavel WHERE plataforma_id = @plataforma_id AND gestor_id = @gestor_id");
        await registrarAuditoriaResponsaveis(transaction, request.usuario!.sub, "remover_responsavel_plataforma", id, {
          ...plataforma.recordset[0],
          removido: { id: removido.gestor_id, nome: removido.nome },
          responsaveisAnteriores: anteriores.map((r) => ({ id: r.gestor_id, nome: r.nome })),
          responsaveisNovos: anteriores
            .filter((r) => r !== removido)
            .map((r) => ({ id: r.gestor_id, nome: r.nome })),
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
      const [item] = await listar(pool, { plataformaId: id });
      return reply.status(200).send(item);
    }
  );
}

async function registrarAuditoriaResponsaveis(
  transaction: sql.Transaction,
  usuarioId: string,
  acao: string,
  plataformaId: string,
  detalhes: Record<string, unknown>
): Promise<void> {
  await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("acao", sql.VarChar, acao)
    .input("entidade_id", sql.UniqueIdentifier, plataformaId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, 'Plataforma', @entidade_id, @detalhes)`
    );
}
