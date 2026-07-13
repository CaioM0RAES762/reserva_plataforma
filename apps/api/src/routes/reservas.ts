import type { FastifyInstance } from "fastify";
import {
  alterarStatusReservaSchema,
  conflitoQuerySchema,
  criarReservaSchema,
  rejeitarReservaSchema,
  type CategoriaPlataforma,
  type PrioridadeReserva,
  type RiscoPlataforma,
  type StatusReserva,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import {
  encontrarBloqueioConflitante,
  encontrarConflito,
  type BloqueioAtivo,
  type ReservaExistente,
} from "../services/conflito.service.js";
import { diaSemanaDe, gerarDatasRecorrencia } from "../services/recorrencia.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { requerChecklist } from "../services/checklist.service.js";
import {
  templateNovaReservaPendente,
  templateReservaAprovada,
  templateReservaRejeitada,
  templateSegundaAprovacaoNecessaria,
} from "../services/email.service.js";
import {
  AprovacaoJaRealizadaError,
  decidirAprovacao,
  transicionar,
  TransicaoInvalidaError,
  type PerfilAprovador,
} from "../services/aprovacao.service.js";
import { registrarNotificacao, type NotificacaoRegistrada } from "../services/notificacao.service.js";
import { publicarEventoGlobal, publicarEventoUsuario } from "../services/eventos.service.js";

interface ReservaConflitoRow {
  id: string;
  hora_inicio: string;
  hora_fim: string;
  setor_nome: string;
}

export interface ReservaRow {
  id: string;
  setor_id: string;
  setor_nome: string;
  solicitante_id: string;
  solicitante_nome: string;
  plataforma_id: string;
  plataforma_nome: string;
  plataforma_categoria: string;
  data: string;
  hora_inicio: string;
  hora_fim: string;
  motivo: string;
  prioridade: string;
  status: string;
  aprovado_por_nome: string | null;
  segunda_aprovacao_por_nome: string | null;
  motivo_rejeicao: string | null;
  hora_inicio_real: string | null;
  hora_fim_real: string | null;
  recorrencia_id: string | null;
  criado_em: Date;
  atualizado_em: Date;
}

export const SELECT_RESERVA = `
  r.id, r.setor_id, s.nome AS setor_nome,
  r.solicitante_id, u.nome AS solicitante_nome,
  r.plataforma_id, p.nome AS plataforma_nome, p.categoria AS plataforma_categoria,
  CONVERT(varchar(10), r.data, 23) AS data,
  CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
  CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
  r.motivo, r.prioridade, r.status,
  aprovador.nome AS aprovado_por_nome,
  segundo_aprovador.nome AS segunda_aprovacao_por_nome,
  r.motivo_rejeicao,
  CONVERT(varchar(5), r.hora_inicio_real, 108) AS hora_inicio_real,
  CONVERT(varchar(5), r.hora_fim_real, 108) AS hora_fim_real,
  r.recorrencia_id,
  r.criado_em, r.atualizado_em`;

export const FROM_RESERVA = `
  FROM Reserva r
  JOIN Setor s ON s.id = r.setor_id
  JOIN Usuario u ON u.id = r.solicitante_id
  JOIN Plataforma p ON p.id = r.plataforma_id
  LEFT JOIN Usuario aprovador ON aprovador.id = r.aprovado_por_id
  LEFT JOIN Usuario segundo_aprovador ON segundo_aprovador.id = r.segunda_aprovacao_por_id`;

export function mapReserva(row: ReservaRow) {
  return {
    id: row.id,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    solicitanteId: row.solicitante_id,
    solicitanteNome: row.solicitante_nome,
    plataformaId: row.plataforma_id,
    plataformaNome: row.plataforma_nome,
    plataformaCategoria: row.plataforma_categoria,
    data: row.data,
    horaInicio: row.hora_inicio,
    horaFim: row.hora_fim,
    motivo: row.motivo,
    prioridade: row.prioridade,
    status: row.status,
    aprovadoPorNome: row.aprovado_por_nome,
    segundaAprovacaoPorNome: row.segunda_aprovacao_por_nome,
    motivoRejeicao: row.motivo_rejeicao,
    horaInicioReal: row.hora_inicio_real,
    horaFimReal: row.hora_fim_real,
    recorrenciaId: row.recorrencia_id,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function registrarAuditoriaReserva(
  transaction: sql.Transaction,
  usuarioId: string,
  acao: string,
  reservaId: string,
  detalhes: Record<string, unknown>
): Promise<void> {
  await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("acao", sql.VarChar, acao)
    .input("entidade_id", sql.UniqueIdentifier, reservaId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, 'Reserva', @entidade_id, @detalhes)`
    );
}

interface ReservaContexto {
  id: string;
  status: StatusReserva;
  setor_id: string;
  solicitante_id: string;
  solicitante_email: string;
  plataforma_nome: string;
  plataforma_risco: RiscoPlataforma;
  plataforma_categoria: CategoriaPlataforma;
  prioridade: PrioridadeReserva;
  aprovado_por_id: string | null;
  data: string;
  hora_inicio: string;
  hora_fim: string;
}

async function buscarContextoReserva(id: string): Promise<ReservaContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaContexto>(
      `SELECT r.id, r.status, r.setor_id, r.solicitante_id, u.email AS solicitante_email,
              p.nome AS plataforma_nome, p.risco AS plataforma_risco, p.categoria AS plataforma_categoria,
              r.prioridade, r.aprovado_por_id,
              CONVERT(varchar(10), r.data, 23) AS data,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim
       FROM Reserva r
       JOIN Usuario u ON u.id = r.solicitante_id
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
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

interface BloqueioAtivoRow {
  id: string;
  plataforma_id: string | null;
  data_inicio: Date;
  data_fim: Date;
  motivo: string;
}

// S9 (RN-RES-11): bloqueios (globais ou da própria plataforma) que tocam o dia da
// reserva. A sobreposição exata contra o horário é decidida em conflito.service.ts.
async function buscarBloqueiosAtivos(plataformaId: string, data: string): Promise<BloqueioAtivoRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("data", sql.Date, data)
    .query<BloqueioAtivoRow>(
      `SELECT id, plataforma_id, data_inicio, data_fim, motivo FROM BloqueioAgenda
       WHERE (plataforma_id = @plataforma_id OR plataforma_id IS NULL)
         AND data_inicio < DATEADD(DAY, 1, CAST(@data AS DATETIME2))
         AND data_fim > CAST(@data AS DATETIME2)`
    );
  return result.recordset;
}

function mapBloqueioAtivo(row: BloqueioAtivoRow): BloqueioAtivo {
  return { id: row.id, plataformaId: row.plataforma_id, dataInicio: row.data_inicio, dataFim: row.data_fim, motivo: row.motivo };
}

function formatarDataHora(data: Date): string {
  return data.toISOString().slice(0, 16).replace("T", " ");
}

interface DisponibilidadeResultado {
  ok: boolean;
  erro?: string;
  reservaConflitante?: { id: string; setorNome: string; horaInicio: string; horaFim: string };
}

// Reúne as duas checagens de RN-RES-02 (conflito com outra reserva) e RN-RES-11
// (bloqueio de agenda ativo) — usada tanto na criação (única e recorrente) quanto na
// checagem em tempo real do formulário (GET /reservas/conflitos).
async function verificarDisponibilidade(dados: {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  ignorarReservaId?: string;
}): Promise<DisponibilidadeResultado> {
  const conflitantes = await buscarReservasConflitantes(dados.plataformaId, dados.data, dados.ignorarReservaId);
  const conflito = encontrarConflito(
    conflitantes.map<ReservaExistente>((r) => ({ id: r.id, horaInicio: r.hora_inicio, horaFim: r.hora_fim })),
    { horaInicio: dados.horaInicio, horaFim: dados.horaFim, ignorarReservaId: dados.ignorarReservaId }
  );
  if (conflito) {
    const detalhe = conflitantes.find((r) => r.id === conflito.id)!;
    return {
      ok: false,
      erro: `Conflito de horário com reserva do setor ${detalhe.setor_nome} (${detalhe.hora_inicio}–${detalhe.hora_fim}).`,
      reservaConflitante: {
        id: detalhe.id,
        setorNome: detalhe.setor_nome,
        horaInicio: detalhe.hora_inicio,
        horaFim: detalhe.hora_fim,
      },
    };
  }

  const bloqueiosAtivos = await buscarBloqueiosAtivos(dados.plataformaId, dados.data);
  const bloqueio = encontrarBloqueioConflitante(bloqueiosAtivos.map(mapBloqueioAtivo), dados.plataformaId, {
    data: dados.data,
    horaInicio: dados.horaInicio,
    horaFim: dados.horaFim,
  });
  if (bloqueio) {
    return {
      ok: false,
      erro: `Reserva bloqueada pela agenda: ${bloqueio.motivo} (bloqueio de ${formatarDataHora(bloqueio.dataInicio)} a ${formatarDataHora(bloqueio.dataFim)}).`,
    };
  }

  return { ok: true };
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

    const { plataformaId, data, horaInicio, horaFim, motivo, prioridade, recorrencia } = parsed.data;
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
    // RN-PLAT-04 (S11): ocorrência com gera_manutencao=1 move a plataforma para
    // "manutencao" e bloqueia novas reservas até reversão manual pelo Admin — mesmo
    // tratamento de "inativa" aqui.
    if (plataforma_status === "inativa" || plataforma_status === "manutencao") {
      return reply.status(409).send({
        erro:
          plataforma_status === "inativa"
            ? "Esta plataforma está inativa e não pode ser reservada."
            : "Esta plataforma está em manutenção e não pode ser reservada (RN-PLAT-04).",
      });
    }

    // S10 (RF-NOT-01 / RN-RES-07): aprovadores elegíveis para a notificação de reserva
    // pendente — Admins ativos + Gestor(es) do setor solicitante.
    const aprovadoresElegiveis = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .query<{ id: string; email: string }>(
        `SELECT id, email FROM Usuario
         WHERE ativo = 1 AND (perfil = 'admin' OR (perfil = 'gestor_setor' AND setor_id = @setor_id))`
      );

    // S9 (RF-RES-03): sem recorrência, a "série" é só a própria data solicitada.
    const datasOcorrencias = recorrencia
      ? gerarDatasRecorrencia(data, diaSemanaDe(data), recorrencia.quantidadeOcorrencias)
      : [data];

    // RN-RES-02/RN-RES-11: checa disponibilidade de TODAS as ocorrências antes de
    // inserir qualquer uma — série é tudo ou nada.
    for (const dataOcorrencia of datasOcorrencias) {
      const disponibilidade = await verificarDisponibilidade({
        plataformaId,
        data: dataOcorrencia,
        horaInicio,
        horaFim,
      });
      if (!disponibilidade.ok) {
        return reply.status(409).send({
          erro: recorrencia
            ? `Não foi possível criar a série semanal: ${disponibilidade.erro} (ocorrência de ${dataOcorrencia}).`
            : disponibilidade.erro,
        });
      }
    }

    const transaction = pool.transaction();
    await transaction.begin();
    const notificacoesCriadas: NotificacaoRegistrada[] = [];
    try {
      let recorrenciaId: string | null = null;
      if (recorrencia) {
        const insercaoRecorrencia = await transaction
          .request()
          .input("criado_por_id", sql.UniqueIdentifier, solicitanteId)
          .input("dia_semana", sql.TinyInt, diaSemanaDe(data))
          .input("quantidade_ocorrencias", sql.TinyInt, recorrencia.quantidadeOcorrencias)
          .query<{ id: string }>(
            `INSERT INTO ReservaRecorrencia (criado_por_id, dia_semana, quantidade_ocorrencias)
             OUTPUT INSERTED.id
             VALUES (@criado_por_id, @dia_semana, @quantidade_ocorrencias)`
          );
        recorrenciaId = insercaoRecorrencia.recordset[0].id;
      }

      for (const dataOcorrencia of datasOcorrencias) {
        const insercao = await transaction
          .request()
          .input("setor_id", sql.UniqueIdentifier, setorId)
          .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
          .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
          .input("data", sql.Date, dataOcorrencia)
          .input("hora_inicio", sql.VarChar, horaInicio)
          .input("hora_fim", sql.VarChar, horaFim)
          .input("motivo", sql.NVarChar, motivo)
          .input("prioridade", sql.VarChar, prioridade)
          .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
          .query<{ id: string }>(
            `INSERT INTO Reserva (setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim, motivo, prioridade, recorrencia_id)
             OUTPUT INSERTED.id
             VALUES (@setor_id, @solicitante_id, @plataforma_id, @data, @hora_inicio, @hora_fim, @motivo, @prioridade, @recorrencia_id)`
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
            JSON.stringify({ plataformaId, data: dataOcorrencia, horaInicio, horaFim, prioridade, recorrenciaId })
          )
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
          );

        // S10 (RF-NOT-01): notificação in-app persistida na mesma transação da criação —
        // uma por aprovador elegível, por ocorrência (mesmo padrão de fan-out do e-mail).
        for (const aprovador of aprovadoresElegiveis.recordset) {
          notificacoesCriadas.push(
            await registrarNotificacao(transaction, {
              usuarioId: aprovador.id,
              tipo: "reserva_pendente",
              titulo: "Nova reserva pendente de aprovação",
              mensagem: `${solicitante_nome} solicitou ${plataforma_nome} em ${dataOcorrencia} (${horaInicio}–${horaFim}).`,
              link: "/reservas/aprovacoes",
            })
          );
        }
      }

      await transaction.commit();

      let novas: ReturnType<typeof mapReserva>[];
      if (recorrenciaId) {
        const completas = await pool
          .request()
          .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
          .query<ReservaRow>(
            `SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.recorrencia_id = @recorrencia_id ORDER BY r.data ASC`
          );
        novas = completas.recordset.map(mapReserva);
      } else {
        const completa = await pool
          .request()
          .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
          .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
          .input("data", sql.Date, data)
          .input("hora_inicio", sql.VarChar, horaInicio)
          .query<ReservaRow>(
            `SELECT TOP 1 ${SELECT_RESERVA} ${FROM_RESERVA}
             WHERE r.plataforma_id = @plataforma_id AND r.solicitante_id = @solicitante_id
               AND r.data = @data AND r.hora_inicio = @hora_inicio
             ORDER BY r.criado_em DESC`
          );
        novas = [mapReserva(completa.recordset[0])];
      }

      // S10 (SDD §3.4): publica reserva.criada (badge de aprovações) e notificacao.nova
      // (sino) aos aprovadores elegíveis, via SSE, já fora da transação (best-effort —
      // uma conexão SSE ausente não deve nunca reverter a criação da reserva).
      for (const aprovador of aprovadoresElegiveis.recordset) {
        for (const nova of novas) {
          publicarEventoUsuario(aprovador.id, "reserva.criada", nova);
        }
      }
      for (const notificacao of notificacoesCriadas) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
      }

      // Notificação ao(s) Admin(s) ativos — uma por ocorrência, fila BullMQ, nunca
      // síncrono bloqueando a resposta HTTP.
      const admins = await pool
        .request()
        .query<{ email: string }>("SELECT email FROM Usuario WHERE perfil = 'admin' AND ativo = 1");
      await Promise.all(
        novas.map((nova) => {
          const { assunto, corpoHtml } = templateNovaReservaPendente({
            plataformaNome: plataforma_nome,
            setorNome: setor_nome,
            solicitanteNome: solicitante_nome,
            data: nova.data,
            horaInicio,
            horaFim,
            motivo,
            prioridade,
          });
          return Promise.all(
            admins.recordset.map((admin) => enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml }))
          );
        })
      );

      return reply.status(201).send(recorrenciaId ? { recorrenciaId, reservas: novas } : novas[0]);
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  });

  // S9 (RF-RES-03): cancela todas as ocorrências futuras (pendente/agendada) de uma
  // série semanal de uma vez. Escopo verificado pela primeira reserva da série — todas
  // pertencem ao mesmo setor/solicitante, pois a série nasce de uma única submissão.
  app.post(
    "/api/v1/reservas/recorrencia/:recorrenciaId/cancelar",
    { preHandler: autenticar },
    async (request, reply) => {
      const { recorrenciaId } = request.params as { recorrenciaId: string };
      const pool = await getPool();

      const ocorrencias = await pool
        .request()
        .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
        .query<{ id: string; status: StatusReserva; setor_id: string }>(
          `SELECT id, status, setor_id FROM Reserva
           WHERE recorrencia_id = @recorrencia_id AND status IN ('pendente','agendada')`
        );
      if (ocorrencias.recordset.length === 0) {
        return reply
          .status(404)
          .send({ erro: "Nenhuma ocorrência futura cancelável encontrada para esta série." });
      }

      const perfil = request.usuario!.perfil;
      const setorSerie = ocorrencias.recordset[0].setor_id;
      if (perfil !== "admin" && setorSerie !== request.usuario!.setorId) {
        return reply.status(403).send({ erro: "Você só pode cancelar séries de reservas do seu próprio setor." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      const statusPorOcorrencia = new Map<string, StatusReserva>();
      try {
        for (const ocorrencia of ocorrencias.recordset) {
          const novoStatus = transicionar(ocorrencia.status, "cancelar");
          statusPorOcorrencia.set(ocorrencia.id, novoStatus);
          await transaction
            .request()
            .input("id", sql.UniqueIdentifier, ocorrencia.id)
            .input("status", sql.VarChar, novoStatus)
            .query(`UPDATE Reserva SET status = @status, atualizado_em = SYSUTCDATETIME() WHERE id = @id`);
          await registrarAuditoriaReserva(transaction, request.usuario!.sub, "cancelar_serie_reserva", ocorrencia.id, {
            statusAnterior: ocorrencia.status,
            statusNovo: novoStatus,
            recorrenciaId,
          });
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
      for (const [ocorrenciaId, status] of statusPorOcorrencia) {
        publicarEventoGlobal("reserva.status_alterado", { id: ocorrenciaId, status });
      }

      return reply.status(200).send({ ocorrenciasCanceladas: ocorrencias.recordset.length });
    }
  );

  app.get("/api/v1/reservas", { preHandler: autenticar }, async (request, reply) => {
    const { q, status, data, dateFrom, dateTo } = request.query as {
      q?: string;
      status?: string;
      data?: string;
      dateFrom?: string;
      dateTo?: string;
    };
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
    // Usado pelo Calendário: intervalo de datas da semana exibida (S5).
    if (dateFrom) {
      dbRequest.input("date_from", sql.Date, dateFrom);
      where += " AND r.data >= @date_from";
    }
    if (dateTo) {
      dbRequest.input("date_to", sql.Date, dateTo);
      where += " AND r.data <= @date_to";
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

    // S9: mesma checagem usada na criação (reserva-reserva + bloqueio de agenda), para
    // o formulário de Nova Reserva bloquear o envio com a mesma regra do backend.
    const disponibilidade = await verificarDisponibilidade({ plataformaId, data, horaInicio, horaFim, ignorarReservaId });
    if (disponibilidade.ok) {
      return reply.status(200).send({ conflito: false, motivo: null, reserva: null });
    }
    return reply.status(200).send({
      conflito: true,
      motivo: disponibilidade.erro ?? null,
      reserva: disponibilidade.reservaConflitante ?? null,
    });
  });

  // S7 — "Fila de Aprovações": pendentes elegíveis ao aprovador logado.
  // Gestor de Setor: só do próprio setor, e apenas as que ainda não recebeu sua própria
  // aprovação (aprovado_por_id IS NULL) — reservas já aprovadas por ele aguardando a
  // segunda decisão do Admin não exigem nova ação do Gestor.
  // Admin: todas as pendentes de qualquer setor, incluindo as que aguardam segunda aprovação.
  app.get(
    "/api/v1/reservas/fila-aprovacoes",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const usuario = request.usuario!;
      const pool = await getPool();
      const dbRequest = pool.request();

      let where = "WHERE r.status = 'pendente'";
      if (usuario.perfil === "gestor_setor") {
        dbRequest.input("setor_id", sql.UniqueIdentifier, usuario.setorId);
        where += " AND r.setor_id = @setor_id AND r.aprovado_por_id IS NULL";
      }

      const result = await dbRequest.query<
        ReservaRow & { sla_horas: number; sla_estourado: boolean }
      >(
        `SELECT ${SELECT_RESERVA},
                CAST((SELECT valor FROM ConfiguracaoSistema WHERE chave = 'sla_aprovacao_urgente_horas') AS INT) AS sla_horas,
                CASE
                  WHEN r.prioridade = 'urgente'
                   AND DATEDIFF(MINUTE, r.criado_em, SYSUTCDATETIME()) >=
                       CAST((SELECT valor FROM ConfiguracaoSistema WHERE chave = 'sla_aprovacao_urgente_horas') AS INT) * 60
                  THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT)
                END AS sla_estourado
         ${FROM_RESERVA} ${where}
         ORDER BY CASE WHEN r.prioridade = 'urgente' THEN 0 WHEN r.prioridade = 'alta' THEN 1 ELSE 2 END, r.criado_em ASC`
      );

      return reply.status(200).send(
        result.recordset.map((row) => ({
          ...mapReserva(row),
          aguardaSegundaAprovacao: row.aprovado_por_nome !== null,
          slaHoras: row.sla_horas,
          slaEstourado: Boolean(row.sla_estourado),
        }))
      );
    }
  );

  // S7 (RN-RES-07/08): aprovar/rejeitar/iniciar_uso/concluir agora aceitam Admin e
  // Gestor de Setor (ADR-S4 relaxado, conforme já previsto no relatório de S6). Gestor
  // fica restrito ao próprio setor (usuarioNoEscopoDaReserva); Admin não tem restrição.
  app.post(
    "/api/v1/reservas/:id/aprovar",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      const usuario = request.usuario!;
      if (!usuarioNoEscopoDaReserva(usuario, contexto.setor_id)) {
        return reply.status(403).send({ erro: "Você só pode aprovar reservas do seu próprio setor." });
      }

      let resultado;
      try {
        resultado = decidirAprovacao(usuario.perfil as PerfilAprovador, {
          statusAtual: contexto.status,
          prioridade: contexto.prioridade,
          risco: contexto.plataforma_risco,
          aprovadoPorId: contexto.aprovado_por_id,
        });
      } catch (err) {
        if (err instanceof TransicaoInvalidaError || err instanceof AprovacaoJaRealizadaError) {
          return reply.status(409).send({ erro: err.message });
        }
        throw err;
      }

      const pool = await getPool();
      // S10: buscado antes da transação para poder gravar a Notificacao in-app na mesma
      // transação da decisão de aprovação (invariante de auditoria, aplicada por analogia).
      const admins = await pool
        .request()
        .query<{ id: string; email: string }>("SELECT id, email FROM Usuario WHERE perfil = 'admin' AND ativo = 1");

      const transaction = pool.transaction();
      await transaction.begin();
      let notificacaoSolicitante: NotificacaoRegistrada | null = null;
      const notificacoesAdmins: NotificacaoRegistrada[] = [];
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("status", sql.VarChar, resultado.novoStatus)
          .input("aprovador_id", sql.UniqueIdentifier, usuario.sub)
          .query(
            `UPDATE Reserva SET status = @status, ${resultado.campo} = @aprovador_id, atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );
        await registrarAuditoriaReserva(transaction, usuario.sub, "aprovar_reserva", id, {
          perfilAprovador: usuario.perfil,
          campo: resultado.campo,
          statusAnterior: contexto.status,
          statusNovo: resultado.novoStatus,
        });

        if (resultado.novoStatus === "agendada") {
          notificacaoSolicitante = await registrarNotificacao(transaction, {
            usuarioId: contexto.solicitante_id,
            tipo: "reserva_aprovada",
            titulo: "Reserva aprovada",
            mensagem: `Sua reserva de ${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) foi aprovada.`,
            link: `/reservas/${id}`,
          });
        } else {
          // RN-RES-08 / UC-02: Gestor deu a primeira aprovação — reserva permanece
          // pendente aguardando a segunda decisão do Admin.
          for (const admin of admins.recordset) {
            notificacoesAdmins.push(
              await registrarNotificacao(transaction, {
                usuarioId: admin.id,
                tipo: "reserva_pendente",
                titulo: "Aguarda segunda aprovação",
                mensagem: `${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) já foi aprovada pelo Gestor e aguarda sua decisão.`,
                link: "/reservas/aprovacoes",
              })
            );
          }
        }

        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      if (resultado.novoStatus === "agendada") {
        const { assunto, corpoHtml } = templateReservaAprovada({
          plataformaNome: contexto.plataforma_nome,
          data: contexto.data,
          horaInicio: contexto.hora_inicio,
          horaFim: contexto.hora_fim,
        });
        await enfileirarEmail({ destinatario: contexto.solicitante_email, assunto, corpoHtml });
        publicarEventoUsuario(contexto.solicitante_id, "reserva.aprovada", { id, status: resultado.novoStatus });
        if (notificacaoSolicitante) {
          publicarEventoUsuario(contexto.solicitante_id, "notificacao.nova", notificacaoSolicitante);
        }
      } else {
        // RN-RES-08 / UC-02: Gestor deu a primeira aprovação — reserva permanece
        // pendente aguardando a segunda decisão do Admin.
        const gestorRow = await pool
          .request()
          .input("id", sql.UniqueIdentifier, usuario.sub)
          .query<{ nome: string }>("SELECT nome FROM Usuario WHERE id = @id");
        const { assunto, corpoHtml } = templateSegundaAprovacaoNecessaria({
          plataformaNome: contexto.plataforma_nome,
          data: contexto.data,
          horaInicio: contexto.hora_inicio,
          horaFim: contexto.hora_fim,
          gestorNome: gestorRow.recordset[0]?.nome ?? usuario.email,
        });
        await Promise.all(
          admins.recordset.map((admin) =>
            enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml })
          )
        );
        for (const admin of admins.recordset) {
          publicarEventoUsuario(admin.id, "reserva.criada", { id, status: resultado.novoStatus });
        }
        for (const notificacao of notificacoesAdmins) {
          publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
        }
      }

      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      return reply.status(200).send(mapReserva(completa.recordset[0]));
    }
  );

  app.post(
    "/api/v1/reservas/:id/rejeitar",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = rejeitarReservaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }

      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
        return reply.status(403).send({ erro: "Você só pode rejeitar reservas do seu próprio setor." });
      }

      let novoStatus: StatusReserva;
      try {
        novoStatus = transicionar(contexto.status, "rejeitar");
      } catch (err) {
        if (err instanceof TransicaoInvalidaError) {
          return reply.status(409).send({ erro: err.message });
        }
        throw err;
      }

      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      let notificacaoSolicitante: NotificacaoRegistrada;
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("status", sql.VarChar, novoStatus)
          .input("motivo_rejeicao", sql.NVarChar, parsed.data.motivo)
          .query(
            `UPDATE Reserva SET status = @status, motivo_rejeicao = @motivo_rejeicao, atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );
        await registrarAuditoriaReserva(transaction, request.usuario!.sub, "rejeitar_reserva", id, {
          statusAnterior: contexto.status,
          statusNovo: novoStatus,
          motivo: parsed.data.motivo,
        });
        notificacaoSolicitante = await registrarNotificacao(transaction, {
          usuarioId: contexto.solicitante_id,
          tipo: "reserva_rejeitada",
          titulo: "Reserva rejeitada",
          mensagem: `Sua reserva de ${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) foi rejeitada: ${parsed.data.motivo}`,
          link: `/reservas/${id}`,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }

      const { assunto, corpoHtml } = templateReservaRejeitada({
        plataformaNome: contexto.plataforma_nome,
        data: contexto.data,
        horaInicio: contexto.hora_inicio,
        horaFim: contexto.hora_fim,
        motivo: parsed.data.motivo,
      });
      await enfileirarEmail({ destinatario: contexto.solicitante_email, assunto, corpoHtml });
      publicarEventoUsuario(contexto.solicitante_id, "reserva.rejeitada", { id, status: novoStatus });
      publicarEventoUsuario(contexto.solicitante_id, "notificacao.nova", notificacaoSolicitante);

      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      return reply.status(200).send(mapReserva(completa.recordset[0]));
    }
  );

  app.patch(
    "/api/v1/reservas/:id/status",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = alterarStatusReservaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const acao = parsed.data.acao;

      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
        return reply.status(403).send({ erro: "Você só pode alterar reservas do seu próprio setor." });
      }

      // RF-RES-10/RN-RES-12: plataforma com checklist obrigatório (categoria elevatória
      // ou andaime) só entra em uso com ChecklistPreenchido.todos_conformes = 1.
      if (acao === "iniciar_uso" && requerChecklist(contexto.plataforma_categoria)) {
        const pool = await getPool();
        const checklist = await pool
          .request()
          .input("reserva_id", sql.UniqueIdentifier, id)
          .query<{ todos_conformes: boolean }>(
            "SELECT todos_conformes FROM ChecklistPreenchido WHERE reserva_id = @reserva_id"
          );
        const preenchido = checklist.recordset[0];
        if (!preenchido) {
          return reply.status(409).send({
            erro:
              "Esta plataforma exige checklist de segurança antes do início de uso (NR-18/NR-35) e ele ainda não foi preenchido.",
          });
        }
        if (!preenchido.todos_conformes) {
          return reply.status(409).send({
            erro:
              "O checklist de segurança desta reserva tem item obrigatório não conforme — início de uso bloqueado até revisão da plataforma (RN-CHK-02).",
          });
        }
      }

      let novoStatus: StatusReserva;
      try {
        novoStatus = transicionar(contexto.status, acao);
      } catch (err) {
        if (err instanceof TransicaoInvalidaError) {
          return reply.status(409).send({ erro: err.message });
        }
        throw err;
      }

      const pool = await getPool();
      const campoHoraReal = acao === "iniciar_uso" ? "hora_inicio_real" : "hora_fim_real";
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("status", sql.VarChar, novoStatus)
          .query(
            `UPDATE Reserva SET status = @status, ${campoHoraReal} = CAST(GETDATE() AS TIME), atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );
        await registrarAuditoriaReserva(transaction, request.usuario!.sub, `${acao}_reserva`, id, {
          statusAnterior: contexto.status,
          statusNovo: novoStatus,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
      // S10 (SDD §3.4): reserva.status_alterado — consumido por Dashboard, Painel TV e
      // Calendário de qualquer usuário/dispositivo conectado, sem destinatário específico.
      publicarEventoGlobal("reserva.status_alterado", { id, status: novoStatus });

      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      return reply.status(200).send(mapReserva(completa.recordset[0]));
    }
  );

  // RF-RES-11: Admin cancela qualquer reserva; Colaborador só as do próprio setor.
  app.post("/api/v1/reservas/:id/cancelar", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContextoReserva(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }

    const perfil = request.usuario!.perfil;
    if (perfil !== "admin" && contexto.setor_id !== request.usuario!.setorId) {
      return reply.status(403).send({ erro: "Você só pode cancelar reservas do seu próprio setor." });
    }

    let novoStatus: StatusReserva;
    try {
      novoStatus = transicionar(contexto.status, "cancelar");
    } catch (err) {
      if (err instanceof TransicaoInvalidaError) {
        return reply.status(409).send({ erro: err.message });
      }
      throw err;
    }

    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("status", sql.VarChar, novoStatus)
        .query(`UPDATE Reserva SET status = @status, atualizado_em = SYSUTCDATETIME() WHERE id = @id`);
      await registrarAuditoriaReserva(transaction, request.usuario!.sub, "cancelar_reserva", id, {
        statusAnterior: contexto.status,
        statusNovo: novoStatus,
      });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
    publicarEventoGlobal("reserva.status_alterado", { id, status: novoStatus });

    const completa = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
    return reply.status(200).send(mapReserva(completa.recordset[0]));
  });
}
