import type { FastifyInstance } from "fastify";
import { criarComentarioSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import { registrarNotificacao, type NotificacaoRegistrada } from "../services/notificacao.service.js";
import { publicarEventoUsuario } from "../services/eventos.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateComentarioNovo } from "../services/email.service.js";

interface ReservaComentarioContexto {
  id: string;
  setor_id: string;
  solicitante_id: string;
  plataforma_nome: string;
}

async function buscarContexto(id: string): Promise<ReservaComentarioContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaComentarioContexto>(
      `SELECT r.id, r.setor_id, r.solicitante_id, p.nome AS plataforma_nome
       FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

interface ComentarioRow {
  id: string;
  reserva_id: string;
  usuario_id: string;
  usuario_nome: string;
  mensagem: string;
  criado_em: Date;
}

function mapComentario(row: ComentarioRow) {
  return {
    id: row.id,
    reservaId: row.reserva_id,
    usuarioId: row.usuario_id,
    usuarioNome: row.usuario_nome,
    mensagem: row.mensagem,
    criadoEm: row.criado_em.toISOString(),
  };
}

// RF-RES-15: thread cronológica de comentários por reserva — mesmo escopo de setor das
// demais rotas de sub-recurso da reserva (usuarioNoEscopoDaReserva, S7/S8).
export async function comentariosRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/reservas/:id/comentarios", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContexto(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode consultar comentários de reservas do seu próprio setor." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, id)
      .query<ComentarioRow>(
        `SELECT c.id, c.reserva_id, c.usuario_id, u.nome AS usuario_nome, c.mensagem, c.criado_em
         FROM Comentario c JOIN Usuario u ON u.id = c.usuario_id
         WHERE c.reserva_id = @reserva_id ORDER BY c.criado_em ASC`
      );
    return reply.status(200).send(result.recordset.map(mapComentario));
  });

  app.post("/api/v1/reservas/:id/comentarios", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = criarComentarioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const contexto = await buscarContexto(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode comentar em reservas do seu próprio setor." });
    }

    const autorId = request.usuario!.sub;
    const pool = await getPool();

    // RF-RES-15: "outro(s) participante(s) da conversa" — solicitante da reserva +
    // qualquer pessoa que já comentou nela antes, exceto quem está comentando agora.
    const participantes = await pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, id)
      .input("autor_id", sql.UniqueIdentifier, autorId)
      .input("solicitante_id", sql.UniqueIdentifier, contexto.solicitante_id)
      .query<{ id: string; email: string }>(
        `SELECT DISTINCT u.id, u.email FROM Usuario u
         WHERE u.id IN (
           SELECT c.usuario_id FROM Comentario c WHERE c.reserva_id = @reserva_id
           UNION SELECT @solicitante_id
         ) AND u.id <> @autor_id`
      );

    const transaction = pool.transaction();
    await transaction.begin();
    let novoId: string;
    const notificacoes: NotificacaoRegistrada[] = [];
    try {
      const insercao = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .input("usuario_id", sql.UniqueIdentifier, autorId)
        .input("mensagem", sql.NVarChar, parsed.data.mensagem)
        .query<{ id: string }>(
          `INSERT INTO Comentario (reserva_id, usuario_id, mensagem)
           OUTPUT INSERTED.id
           VALUES (@reserva_id, @usuario_id, @mensagem)`
        );
      novoId = insercao.recordset[0].id;

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, autorId)
        .input("entidade_id", sql.UniqueIdentifier, novoId)
        .input("detalhes", sql.NVarChar, JSON.stringify({ reservaId: id }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'comentar_reserva', 'Comentario', @entidade_id, @detalhes)`
        );

      const autorNome = (
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, autorId)
          .query<{ nome: string }>("SELECT nome FROM Usuario WHERE id = @id")
      ).recordset[0].nome;

      for (const participante of participantes.recordset) {
        notificacoes.push(
          await registrarNotificacao(transaction, {
            usuarioId: participante.id,
            tipo: "comentario_novo",
            titulo: "Novo comentário",
            mensagem: `${autorNome} comentou na reserva de ${contexto.plataforma_nome}: "${parsed.data.mensagem.slice(0, 100)}"`,
            link: `/reservas/${id}`,
          })
        );
      }

      await transaction.commit();

      for (const notificacao of notificacoes) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
      }

      const { assunto, corpoHtml } = templateComentarioNovo({
        plataformaNome: contexto.plataforma_nome,
        autorNome,
        mensagem: parsed.data.mensagem,
      });
      await Promise.all(
        participantes.recordset.map((p) => enfileirarEmail({ destinatario: p.email, assunto, corpoHtml }))
      );
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const completo = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoId)
      .query<ComentarioRow>(
        `SELECT c.id, c.reserva_id, c.usuario_id, u.nome AS usuario_nome, c.mensagem, c.criado_em
         FROM Comentario c JOIN Usuario u ON u.id = c.usuario_id
         WHERE c.id = @id`
      );
    return reply.status(201).send(mapComentario(completo.recordset[0]));
  });
}
