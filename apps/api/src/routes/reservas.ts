import type { FastifyInstance } from "fastify";
import { conflitoQuerySchema, criarReservaSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";
import { encontrarConflito, type ReservaExistente } from "../services/conflito.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateNovaReservaPendente } from "../services/email.service.js";

interface ReservaConflitoRow {
  id: string;
  hora_inicio: string;
  hora_fim: string;
  setor_nome: string;
}

interface ReservaRow {
  id: string;
  setor_id: string;
  setor_nome: string;
  solicitante_id: string;
  solicitante_nome: string;
  plataforma_id: string;
  plataforma_nome: string;
  data: string;
  hora_inicio: string;
  hora_fim: string;
  motivo: string;
  prioridade: string;
  status: string;
  criado_em: Date;
  atualizado_em: Date;
}

const SELECT_RESERVA = `
  r.id, r.setor_id, s.nome AS setor_nome,
  r.solicitante_id, u.nome AS solicitante_nome,
  r.plataforma_id, p.nome AS plataforma_nome,
  CONVERT(varchar(10), r.data, 23) AS data,
  CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
  CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
  r.motivo, r.prioridade, r.status, r.criado_em, r.atualizado_em`;

const FROM_RESERVA = `
  FROM Reserva r
  JOIN Setor s ON s.id = r.setor_id
  JOIN Usuario u ON u.id = r.solicitante_id
  JOIN Plataforma p ON p.id = r.plataforma_id`;

function mapReserva(row: ReservaRow) {
  return {
    id: row.id,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    solicitanteId: row.solicitante_id,
    solicitanteNome: row.solicitante_nome,
    plataformaId: row.plataforma_id,
    plataformaNome: row.plataforma_nome,
    data: row.data,
    horaInicio: row.hora_inicio,
    horaFim: row.hora_fim,
    motivo: row.motivo,
    prioridade: row.prioridade,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function buscarReservasConflitantes(
  plataformaId: string,
  data: string,
  ignorarReservaId?: string
): Promise<ReservaConflitoRow[]> {
  const pool = await getPool();
  const dbRequest = pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("data", sql.Date, data);

  let where = `r.plataforma_id = @plataforma_id AND r.data = @data AND r.status IN ('pendente','agendada','em_uso')`;
  if (ignorarReservaId) {
    dbRequest.input("ignorar_id", sql.UniqueIdentifier, ignorarReservaId);
    where += " AND r.id <> @ignorar_id";
  }

  const result = await dbRequest.query<ReservaConflitoRow>(
    `SELECT r.id, CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
            CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim, s.nome AS setor_nome
     FROM Reserva r JOIN Setor s ON s.id = r.setor_id
     WHERE ${where}`
  );
  return result.recordset;
}

export async function reservasRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/reservas", { preHandler: autenticar }, async (request, reply) => {
    const parsed = criarReservaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const setorId = request.usuario!.setorId;
    const solicitanteId = request.usuario!.sub;
    if (!setorId) {
      return reply
        .status(422)
        .send({ erro: "Sua conta não está vinculada a um setor. Não é possível solicitar reservas." });
    }

    const { plataformaId, data, horaInicio, horaFim, motivo, prioridade } = parsed.data;
    const pool = await getPool();

    const contexto = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .query(
        `SELECT
           (SELECT nome FROM Setor WHERE id = @setor_id) AS setor_nome,
           (SELECT nome FROM Usuario WHERE id = @solicitante_id) AS solicitante_nome,
           (SELECT nome FROM Plataforma WHERE id = @plataforma_id) AS plataforma_nome,
           (SELECT status FROM Plataforma WHERE id = @plataforma_id) AS plataforma_status`
      );
    const { setor_nome, solicitante_nome, plataforma_nome, plataforma_status } = contexto.recordset[0];
    if (!plataforma_nome) {
      return reply.status(404).send({ erro: "Plataforma não encontrada." });
    }
    // RN-PLAT-01: plataforma só pode ser reservada se status diferente de "inativa".
    if (plataforma_status === "inativa") {
      return reply.status(409).send({ erro: "Esta plataforma está inativa e não pode ser reservada." });
    }

    const conflitantes = await buscarReservasConflitantes(plataformaId, data);
    const conflito = encontrarConflito(
      conflitantes.map<ReservaExistente>((r) => ({ id: r.id, horaInicio: r.hora_inicio, horaFim: r.hora_fim })),
      { horaInicio, horaFim }
    );
    if (conflito) {
      const detalhe = conflitantes.find((r) => r.id === conflito.id)!;
      return reply.status(409).send({
        erro: `Conflito de horário com reserva do setor ${detalhe.setor_nome} (${detalhe.hora_inicio}–${detalhe.hora_fim}).`,
      });
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const insercao = await transaction
        .request()
        .input("setor_id", sql.UniqueIdentifier, setorId)
        .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
        .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
        .input("data", sql.Date, data)
        .input("hora_inicio", sql.VarChar, horaInicio)
        .input("hora_fim", sql.VarChar, horaFim)
        .input("motivo", sql.NVarChar, motivo)
        .input("prioridade", sql.VarChar, prioridade)
        .query<{ id: string }>(
          `INSERT INTO Reserva (setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim, motivo, prioridade)
           OUTPUT INSERTED.id
           VALUES (@setor_id, @solicitante_id, @plataforma_id, @data, @hora_inicio, @hora_fim, @motivo, @prioridade)`
        );
      const novaId = insercao.recordset[0].id;

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, solicitanteId)
        .input("acao", sql.VarChar, "criar_reserva")
        .input("entidade", sql.VarChar, "Reserva")
        .input("entidade_id", sql.UniqueIdentifier, novaId)
        .input(
          "detalhes",
          sql.NVarChar,
          JSON.stringify({ plataformaId, data, horaInicio, horaFim, prioridade })
        )
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
        );

      await transaction.commit();

      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, novaId)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      const nova = mapReserva(completa.recordset[0]);

      // Notificação ao(s) Admin(s) ativos — fila BullMQ, nunca síncrono bloqueando a resposta HTTP.
      const admins = await pool
        .request()
        .query<{ email: string }>("SELECT email FROM Usuario WHERE perfil = 'admin' AND ativo = 1");
      const { assunto, corpoHtml } = templateNovaReservaPendente({
        plataformaNome: plataforma_nome,
        setorNome: setor_nome,
        solicitanteNome: solicitante_nome,
        data,
        horaInicio,
        horaFim,
        motivo,
        prioridade,
      });
      await Promise.all(
        admins.recordset.map((admin) =>
          enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml })
        )
      );

      return reply.status(201).send(nova);
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  });

  app.get("/api/v1/reservas", { preHandler: autenticar }, async (request, reply) => {
    const { q, status, data } = request.query as { q?: string; status?: string; data?: string };
    const pool = await getPool();
    const dbRequest = pool.request();

    let where = "WHERE 1=1";
    if (request.usuario!.perfil !== "admin") {
      dbRequest.input("setor_id", sql.UniqueIdentifier, request.usuario!.setorId);
      where += " AND r.setor_id = @setor_id";
    }
    if (q) {
      dbRequest.input("q", sql.NVarChar, `%${q}%`);
      where += " AND (s.nome LIKE @q OR u.nome LIKE @q OR p.nome LIKE @q)";
    }
    if (status) {
      dbRequest.input("status", sql.VarChar, status);
      where += " AND r.status = @status";
    }
    if (data) {
      dbRequest.input("data", sql.Date, data);
      where += " AND r.data = @data";
    }

    const result = await dbRequest.query<ReservaRow>(
      `SELECT ${SELECT_RESERVA} ${FROM_RESERVA} ${where} ORDER BY r.data DESC, r.hora_inicio DESC`
    );
    return reply.status(200).send(result.recordset.map(mapReserva));
  });

  app.get("/api/v1/reservas/conflitos", { preHandler: autenticar }, async (request, reply) => {
    const parsed = conflitoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    const { plataformaId, data, horaInicio, horaFim, ignorarReservaId } = parsed.data;

    const conflitantes = await buscarReservasConflitantes(plataformaId, data, ignorarReservaId);
    const conflito = encontrarConflito(
      conflitantes.map<ReservaExistente>((r) => ({ id: r.id, horaInicio: r.hora_inicio, horaFim: r.hora_fim })),
      { horaInicio, horaFim }
    );

    if (!conflito) {
      return reply.status(200).send({ conflito: false, reserva: null });
    }
    const detalhe = conflitantes.find((r) => r.id === conflito.id)!;
    return reply.status(200).send({
      conflito: true,
      reserva: { id: detalhe.id, setorNome: detalhe.setor_nome, horaInicio: detalhe.hora_inicio, horaFim: detalhe.hora_fim },
    });
  });
}
