import type { FastifyInstance } from "fastify";
import { criarBloqueioSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { reservasDentroDoIntervalo, type ReservaComData } from "../services/conflito.service.js";

interface BloqueioRow {
  id: string;
  plataforma_id: string | null;
  plataforma_nome: string | null;
  data_inicio: Date;
  data_fim: Date;
  motivo: string;
  criado_por_nome: string;
  criado_em: Date;
}

function mapBloqueio(row: BloqueioRow) {
  return {
    id: row.id,
    plataformaId: row.plataforma_id,
    plataformaNome: row.plataforma_nome,
    dataInicio: row.data_inicio.toISOString(),
    dataFim: row.data_fim.toISOString(),
    motivo: row.motivo,
    criadoPorNome: row.criado_por_nome,
    criadoEm: row.criado_em.toISOString(),
  };
}

const SELECT_BLOQUEIO = `
  b.id, b.plataforma_id, p.nome AS plataforma_nome,
  b.data_inicio, b.data_fim, b.motivo,
  u.nome AS criado_por_nome, b.criado_em`;
const FROM_BLOQUEIO = `
  FROM BloqueioAgenda b
  LEFT JOIN Plataforma p ON p.id = b.plataforma_id
  JOIN Usuario u ON u.id = b.criado_por_id`;

export async function bloqueiosRoutes(app: FastifyInstance): Promise<void> {
  // RF-BLK-02/RF-CAL-01: leitura liberada a todos os perfis autenticados — tanto a
  // tela administrativa de bloqueios (Admin) quanto o Calendário (Todos, para exibir
  // os bloqueios de forma visualmente distinta) usam a mesma rota.
  app.get("/api/v1/bloqueios", { preHandler: autenticar }, async (_request, reply) => {
    const pool = await getPool();
    const result = await pool
      .request()
      .query<BloqueioRow>(`SELECT ${SELECT_BLOQUEIO} ${FROM_BLOQUEIO} ORDER BY b.data_inicio DESC`);
    return reply.status(200).send(result.recordset.map(mapBloqueio));
  });

  app.post(
    "/api/v1/bloqueios",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarBloqueioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { motivo, confirmar } = parsed.data;
      const plataformaId = parsed.data.plataformaId ?? null;
      const dataInicio = new Date(parsed.data.dataInicio);
      const dataFim = new Date(parsed.data.dataFim);

      const pool = await getPool();

      if (plataformaId) {
        const plataforma = await pool
          .request()
          .input("id", sql.UniqueIdentifier, plataformaId)
          .query("SELECT id FROM Plataforma WHERE id = @id");
        if (plataforma.recordset.length === 0) {
          return reply.status(404).send({ erro: "Plataforma não encontrada." });
        }
      }

      // RN-BLK-01: bloqueio não pode se sobrepor a reservas já agendada/em_uso sem
      // confirmação explícita. Busca candidatas por data (faixa larga) e depois refina
      // com a sobreposição exata via conflito.service.ts (unit-testável).
      const dbRequest = pool
        .request()
        .input("data_inicio_dia", sql.Date, dataInicio)
        .input("data_fim_dia", sql.Date, dataFim);
      let where = "r.status IN ('agendada','em_uso') AND r.data BETWEEN @data_inicio_dia AND @data_fim_dia";
      if (plataformaId) {
        dbRequest.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
        where += " AND r.plataforma_id = @plataforma_id";
      }
      const candidatas = await dbRequest.query<
        ReservaComData & { setor_nome: string; plataforma_nome: string }
      >(
        `SELECT r.id, CONVERT(varchar(10), r.data, 23) AS data,
                CONVERT(varchar(5), r.hora_inicio, 108) AS horaInicio,
                CONVERT(varchar(5), r.hora_fim, 108) AS horaFim,
                s.nome AS setor_nome, p.nome AS plataforma_nome
         FROM Reserva r JOIN Setor s ON s.id = r.setor_id JOIN Plataforma p ON p.id = r.plataforma_id
         WHERE ${where}`
      );

      const conflitantes = reservasDentroDoIntervalo(candidatas.recordset, { dataInicio, dataFim });

      if (conflitantes.length > 0 && !confirmar) {
        return reply.status(200).send({
          requerConfirmacao: true,
          reservasConflitantes: conflitantes.map((r) => ({
            id: r.id,
            setorNome: r.setor_nome,
            plataformaNome: r.plataforma_nome,
            data: r.data,
            horaInicio: r.horaInicio,
            horaFim: r.horaFim,
          })),
        });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
          .input("data_inicio", sql.DateTime2, dataInicio)
          .input("data_fim", sql.DateTime2, dataFim)
          .input("motivo", sql.NVarChar, motivo)
          .input("criado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .query<{ id: string }>(
            `INSERT INTO BloqueioAgenda (plataforma_id, data_inicio, data_fim, motivo, criado_por_id)
             OUTPUT INSERTED.id
             VALUES (@plataforma_id, @data_inicio, @data_fim, @motivo, @criado_por_id)`
          );
        const novoId = insercao.recordset[0].id;

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, novoId)
          .input(
            "detalhes",
            sql.NVarChar,
            JSON.stringify({ plataformaId, motivo, confirmadoComReservasConflitantes: conflitantes.length > 0 })
          )
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'criar_bloqueio', 'BloqueioAgenda', @entidade_id, @detalhes)`
          );

        await transaction.commit();

        const completo = await pool
          .request()
          .input("id", sql.UniqueIdentifier, novoId)
          .query<BloqueioRow>(`SELECT ${SELECT_BLOQUEIO} ${FROM_BLOQUEIO} WHERE b.id = @id`);
        return reply.status(201).send(mapBloqueio(completo.recordset[0]));
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );

  app.delete(
    "/api/v1/bloqueios/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ id: string; data_inicio: Date }>("SELECT id, data_inicio FROM BloqueioAgenda WHERE id = @id");
      const bloqueio = atual.recordset[0];
      if (!bloqueio) {
        return reply.status(404).send({ erro: "Bloqueio não encontrado." });
      }
      // RF-BLK-02: apenas bloqueios futuros podem ser removidos.
      if (bloqueio.data_inicio.getTime() <= Date.now()) {
        return reply.status(409).send({ erro: "Somente bloqueios futuros podem ser removidos." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query("DELETE FROM BloqueioAgenda WHERE id = @id");
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, id)
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'remover_bloqueio', 'BloqueioAgenda', @entidade_id, '{}')`
          );
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      return reply.status(204).send();
    }
  );
}
