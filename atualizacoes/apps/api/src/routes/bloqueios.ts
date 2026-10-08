import type { FastifyInstance } from "fastify";
import { combinarDataHoraBrasilia, criarBloqueioSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { reservasDentroDoIntervalo, type ReservaComData } from "../services/conflito.service.js";

// "YYYY-MM-DDTHH:mm" (formato de <input type="datetime-local">, sem fuso — garantido pelo
// regex de criarBloqueioSchema) → instante UTC real, convertendo o horário como Brasília.
// BUG CORRIGIDO: antes usava `new Date(stringSemFuso)`, que o motor JS interpreta usando o
// fuso do PROCESSO NODE (nunca fixado neste repo) — em vez de sempre Brasília, ficava
// dependente de como o servidor de produção está configurado. Isso fazia bloqueios de
// horário específico não baterem certo contra o instante da reserva (que já usa
// combinarDataHoraBrasilia em conflito.service.ts), deixando reservas dentro do bloqueio
// passarem sem serem barradas.
function combinarDataHoraLocalInput(valor: string): Date {
  const [data, hora] = valor.split("T");
  return combinarDataHoraBrasilia(data, hora);
}

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
      const dataInicio = combinarDataHoraLocalInput(parsed.data.dataInicio);
      const dataFim = combinarDataHoraLocalInput(parsed.data.dataFim);

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
      // confirmação explícita. Busca candidatas por data (faixa larga, com 1 dia de folga
      // em cada ponta — dataInicio/dataFim são instantes UTC reais e o dia civil de
      // Brasília correspondente pode cair no dia UTC anterior/seguinte perto da meia-noite)
      // e depois refina com a sobreposição exata via conflito.service.ts (unit-testável).
      const umDiaMs = 24 * 60 * 60 * 1000;
      const dbRequest = pool
        .request()
        .input("data_inicio_dia", sql.Date, new Date(dataInicio.getTime() - umDiaMs))
        .input("data_fim_dia", sql.Date, new Date(dataFim.getTime() + umDiaMs));
      // Sobreposição de dias (reserva de vários dias que começou antes do bloqueio também entra).
      let where = "r.status IN ('agendada','em_uso') AND r.data <= @data_fim_dia AND r.data_fim >= @data_inicio_dia";
      if (plataformaId) {
        dbRequest.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
        where += " AND r.plataforma_id = @plataforma_id";
      }
      const candidatas = await dbRequest.query<
        ReservaComData & { setor_nome: string; plataforma_nome: string }
      >(
        `SELECT r.id, CONVERT(varchar(10), r.data, 23) AS data,
                CONVERT(varchar(10), r.data_fim, 23) AS dataFim,
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
            dataFim: r.dataFim ?? r.data,
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
