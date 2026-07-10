import type { FastifyInstance } from "fastify";
import { historicoQuerySchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";
import { SELECT_RESERVA, FROM_RESERVA, mapReserva, type ReservaRow } from "./reservas.js";

const STATUS_LABELS: Record<string, string> = {
  pendente: "Pendente",
  agendada: "Agendada",
  em_uso: "Em Uso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  rejeitada: "Rejeitada",
};

function formatarDataBr(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHoraBr(dataHora: Date): string {
  return new Date(dataHora).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escaparCampoCsv(valor: string): string {
  return `"${valor.replace(/"/g, '""')}"`;
}

// RF-HIST-01: filtro de setor é resolvido pelo escopo do usuário — Colaborador é sempre
// restrito ao próprio setor, mesmo que envie ?setor=<outro> na query (só Admin filtra livre).
function montarWhereHistorico(
  dbRequest: sql.Request,
  perfil: string,
  setorIdUsuario: string | null,
  filtros: { q?: string; setor?: string; plataforma?: string; status?: string; dateFrom?: string; dateTo?: string }
): string {
  let where = "WHERE 1=1";

  if (perfil !== "admin") {
    dbRequest.input("setor_escopo", sql.UniqueIdentifier, setorIdUsuario);
    where += " AND r.setor_id = @setor_escopo";
  } else if (filtros.setor) {
    dbRequest.input("setor_escopo", sql.UniqueIdentifier, filtros.setor);
    where += " AND r.setor_id = @setor_escopo";
  }

  if (filtros.q) {
    dbRequest.input("q", sql.NVarChar, `%${filtros.q}%`);
    where += " AND (s.nome LIKE @q OR u.nome LIKE @q OR p.nome LIKE @q OR r.motivo LIKE @q)";
  }
  if (filtros.plataforma) {
    dbRequest.input("plataforma_id", sql.UniqueIdentifier, filtros.plataforma);
    where += " AND r.plataforma_id = @plataforma_id";
  }
  if (filtros.status) {
    dbRequest.input("status", sql.VarChar, filtros.status);
    where += " AND r.status = @status";
  }
  if (filtros.dateFrom) {
    dbRequest.input("date_from", sql.Date, filtros.dateFrom);
    where += " AND r.data >= @date_from";
  }
  if (filtros.dateTo) {
    dbRequest.input("date_to", sql.Date, filtros.dateTo);
    where += " AND r.data <= @date_to";
  }

  return where;
}

export async function historicoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/historico", { preHandler: autenticar }, async (request, reply) => {
    const parsed = historicoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }

    const pool = await getPool();
    const dbRequest = pool.request();
    const where = montarWhereHistorico(
      dbRequest,
      request.usuario!.perfil,
      request.usuario!.setorId,
      parsed.data
    );

    const result = await dbRequest.query<ReservaRow>(
      `SELECT ${SELECT_RESERVA} ${FROM_RESERVA} ${where} ORDER BY r.criado_em DESC`
    );
    return reply.status(200).send(result.recordset.map(mapReserva));
  });

  app.get("/api/v1/historico/export", { preHandler: autenticar }, async (request, reply) => {
    const parsed = historicoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }

    const pool = await getPool();
    const dbRequest = pool.request();
    const where = montarWhereHistorico(
      dbRequest,
      request.usuario!.perfil,
      request.usuario!.setorId,
      parsed.data
    );

    const result = await dbRequest.query<ReservaRow>(
      `SELECT ${SELECT_RESERVA} ${FROM_RESERVA} ${where} ORDER BY r.criado_em DESC`
    );

    const cabecalho = [
      "ID",
      "Criada em",
      "Setor",
      "Responsável",
      "Plataforma",
      "Data",
      "Início",
      "Fim",
      "Prioridade",
      "Status",
      "Motivo",
    ];
    const linhas = result.recordset.map((row) =>
      [
        row.id,
        formatarDataHoraBr(row.criado_em),
        row.setor_nome,
        row.solicitante_nome,
        row.plataforma_nome,
        formatarDataBr(row.data),
        row.hora_inicio,
        row.hora_fim,
        row.prioridade,
        STATUS_LABELS[row.status] ?? row.status,
        escaparCampoCsv(row.motivo),
      ].join(";")
    );
    const csv = [cabecalho.join(";"), ...linhas].join("\r\n");

    // RF-HIST-02: UTF-8 com BOM para acentuação correta ao abrir no Excel.
    const conteudo = "﻿" + csv;
    const dataArquivo = new Date().toISOString().slice(0, 10);

    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="historico_${dataArquivo}.csv"`)
      .status(200)
      .send(conteudo);
  });
}
