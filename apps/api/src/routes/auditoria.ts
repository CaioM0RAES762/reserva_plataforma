import type { FastifyInstance } from "fastify";
import { auditoriaQuerySchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";

interface AuditoriaRow {
  id: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  acao: string;
  entidade: string;
  entidade_id: string | null;
  detalhes: string | null;
  criado_em: Date;
}

function mapAuditoria(row: AuditoriaRow) {
  return {
    id: row.id,
    usuarioId: row.usuario_id,
    usuarioNome: row.usuario_nome,
    acao: row.acao,
    entidade: row.entidade,
    entidadeId: row.entidade_id,
    detalhes: row.detalhes ? JSON.parse(row.detalhes) : null,
    criadoEm: row.criado_em,
  };
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

// RF-AUD-01/02 (S12): consulta e exportação do LogAuditoria (persistido desde S1,
// nunca lido via API até esta sprint). Admin only — auditoria é informação sensível
// sobre a atividade de todos os usuários do sistema.
function montarWhereAuditoria(
  dbRequest: sql.Request,
  filtros: { usuarioId?: string; acao?: string; entidade?: string; dateFrom?: string; dateTo?: string }
): string {
  let where = "WHERE 1=1";

  if (filtros.usuarioId) {
    dbRequest.input("usuario_id", sql.UniqueIdentifier, filtros.usuarioId);
    where += " AND la.usuario_id = @usuario_id";
  }
  if (filtros.acao) {
    dbRequest.input("acao", sql.VarChar, filtros.acao);
    where += " AND la.acao = @acao";
  }
  if (filtros.entidade) {
    dbRequest.input("entidade", sql.VarChar, filtros.entidade);
    where += " AND la.entidade = @entidade";
  }
  if (filtros.dateFrom) {
    dbRequest.input("date_from", sql.DateTime2, `${filtros.dateFrom}T00:00:00`);
    where += " AND la.criado_em >= @date_from";
  }
  if (filtros.dateTo) {
    dbRequest.input("date_to", sql.DateTime2, `${filtros.dateTo}T23:59:59`);
    where += " AND la.criado_em <= @date_to";
  }

  return where;
}

const SELECT_AUDITORIA = `
  la.id, la.usuario_id, u.nome AS usuario_nome, la.acao, la.entidade, la.entidade_id, la.detalhes, la.criado_em`;
const FROM_AUDITORIA = `FROM LogAuditoria la LEFT JOIN Usuario u ON u.id = la.usuario_id`;

export async function auditoriaRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/auditoria",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = auditoriaQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }

      const pool = await getPool();
      const dbRequest = pool.request();
      const where = montarWhereAuditoria(dbRequest, parsed.data);

      const result = await dbRequest.query<AuditoriaRow>(
        `SELECT TOP 500 ${SELECT_AUDITORIA} ${FROM_AUDITORIA} ${where} ORDER BY la.criado_em DESC`
      );
      return reply.status(200).send(result.recordset.map(mapAuditoria));
    }
  );

  app.get(
    "/api/v1/auditoria/export",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = auditoriaQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }

      const pool = await getPool();
      const dbRequest = pool.request();
      const where = montarWhereAuditoria(dbRequest, parsed.data);

      const result = await dbRequest.query<AuditoriaRow>(
        `SELECT ${SELECT_AUDITORIA} ${FROM_AUDITORIA} ${where} ORDER BY la.criado_em DESC`
      );

      const cabecalho = ["Data/Hora", "Usuário", "Ação", "Entidade", "ID da Entidade", "Detalhes"];
      const linhas = result.recordset.map((row) =>
        [
          formatarDataHoraBr(row.criado_em),
          row.usuario_nome ?? "Sistema",
          row.acao,
          row.entidade,
          row.entidade_id ?? "",
          escaparCampoCsv(row.detalhes ?? ""),
        ].join(";")
      );
      const csv = [cabecalho.join(";"), ...linhas].join("\r\n");

      // RF-AUD-02: UTF-8 com BOM, mesmo padrão de RF-HIST-02 (historico.ts, S5).
      const conteudo = "﻿" + csv;
      const dataArquivo = new Date().toISOString().slice(0, 10);

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="auditoria_${dataArquivo}.csv"`)
        .status(200)
        .send(conteudo);
    }
  );
}
