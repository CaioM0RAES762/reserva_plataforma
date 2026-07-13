import type { FastifyInstance } from "fastify";
import { criarOcorrenciaSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import { registrarNotificacao, type NotificacaoRegistrada } from "../services/notificacao.service.js";
import { publicarEventoGlobal, publicarEventoUsuario } from "../services/eventos.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateOcorrenciaGrave } from "../services/email.service.js";

interface ReservaOcorrenciaContexto {
  id: string;
  setor_id: string;
  setor_nome: string;
  plataforma_id: string;
  plataforma_nome: string;
  plataforma_status: string;
}

async function buscarContexto(id: string): Promise<ReservaOcorrenciaContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaOcorrenciaContexto>(
      `SELECT r.id, r.setor_id, s.nome AS setor_nome,
              p.id AS plataforma_id, p.nome AS plataforma_nome, p.status AS plataforma_status
       FROM Reserva r
       JOIN Setor s ON s.id = r.setor_id
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

interface OcorrenciaRow {
  id: string;
  reserva_id: string;
  plataforma_id: string;
  reportado_por_id: string;
  reportado_por_nome: string;
  descricao: string;
  gravidade: string;
  gera_manutencao: boolean;
  criado_em: Date;
}

function mapOcorrencia(row: OcorrenciaRow) {
  return {
    id: row.id,
    reservaId: row.reserva_id,
    plataformaId: row.plataforma_id,
    reportadoPorId: row.reportado_por_id,
    reportadoPorNome: row.reportado_por_nome,
    descricao: row.descricao,
    gravidade: row.gravidade,
    geraManutencao: row.gera_manutencao,
    criadoEm: row.criado_em.toISOString(),
  };
}

// RF-RES-16/RN-PLAT-04: reportar ocorrência/avaria ao concluir o uso (ou a qualquer
// momento dentro do escopo da reserva). gera_manutencao=1 muda Plataforma.status para
// 'manutencao' NA MESMA TRANSAÇÃO — RN-PLAT-01 (revalidado em POST /reservas) já trata
// 'manutencao' como status que bloqueia novas reservas, então nenhuma outra rota precisa
// de tratamento especial para isso.
export async function ocorrenciasRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/reservas/:id/ocorrencia", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = criarOcorrenciaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const contexto = await buscarContexto(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode reportar ocorrências de reservas do seu próprio setor." });
    }

    const { descricao, gravidade, geraManutencao } = parsed.data;
    const pool = await getPool();
    const admins = await pool
      .request()
      .query<{ id: string; email: string }>("SELECT id, email FROM Usuario WHERE perfil = 'admin' AND ativo = 1");

    const transaction = pool.transaction();
    await transaction.begin();
    let novoId: string;
    const notificacoesAdmins: NotificacaoRegistrada[] = [];
    try {
      const insercao = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .input("plataforma_id", sql.UniqueIdentifier, contexto.plataforma_id)
        .input("reportado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("descricao", sql.NVarChar, descricao)
        .input("gravidade", sql.VarChar, gravidade)
        .input("gera_manutencao", sql.Bit, geraManutencao)
        .query<{ id: string }>(
          `INSERT INTO Ocorrencia (reserva_id, plataforma_id, reportado_por_id, descricao, gravidade, gera_manutencao)
           OUTPUT INSERTED.id
           VALUES (@reserva_id, @plataforma_id, @reportado_por_id, @descricao, @gravidade, @gera_manutencao)`
        );
      novoId = insercao.recordset[0].id;

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("entidade_id", sql.UniqueIdentifier, novoId)
        .input("detalhes", sql.NVarChar, JSON.stringify({ reservaId: id, gravidade, geraManutencao }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'reportar_ocorrencia', 'Ocorrencia', @entidade_id, @detalhes)`
        );

      if (geraManutencao) {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, contexto.plataforma_id)
          .query(`UPDATE Plataforma SET status = 'manutencao', atualizado_em = SYSUTCDATETIME() WHERE id = @id`);
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, contexto.plataforma_id)
          .input(
            "detalhes",
            sql.NVarChar,
            JSON.stringify({ statusAnterior: contexto.plataforma_status, statusNovo: "manutencao", ocorrenciaId: novoId })
          )
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'alterar_status_plataforma', 'Plataforma', @entidade_id, @detalhes)`
          );
      }

      // RF-RES-16: ocorrência de gravidade alta sempre notifica o Admin (in-app), além
      // do e-mail — independente de gerar manutenção automática ou não.
      if (gravidade === "alta") {
        for (const admin of admins.recordset) {
          notificacoesAdmins.push(
            await registrarNotificacao(transaction, {
              usuarioId: admin.id,
              tipo: "ocorrencia_reportada",
              titulo: "Ocorrência de gravidade alta",
              mensagem: `Ocorrência de gravidade alta reportada em ${contexto.plataforma_nome} (${contexto.setor_nome}).`,
              link: `/reservas/${id}`,
            })
          );
        }
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    if (geraManutencao) {
      publicarEventoGlobal("plataforma.status_alterado", { id: contexto.plataforma_id, status: "manutencao" });
    }
    if (gravidade === "alta") {
      for (const notificacao of notificacoesAdmins) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
      }
      const { assunto, corpoHtml } = templateOcorrenciaGrave({
        plataformaNome: contexto.plataforma_nome,
        setorNome: contexto.setor_nome,
        descricao,
        geraManutencao,
      });
      await Promise.all(
        admins.recordset.map((admin) => enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml }))
      );
    }

    const completo = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoId)
      .query<OcorrenciaRow>(
        `SELECT o.id, o.reserva_id, o.plataforma_id, o.reportado_por_id, u.nome AS reportado_por_nome,
                o.descricao, o.gravidade, o.gera_manutencao, o.criado_em
         FROM Ocorrencia o JOIN Usuario u ON u.id = o.reportado_por_id
         WHERE o.id = @id`
      );
    return reply.status(201).send(mapOcorrencia(completo.recordset[0]));
  });
}
