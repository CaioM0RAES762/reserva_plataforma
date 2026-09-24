import type { FastifyInstance } from "fastify";
import {
  ACOES_POR_CATEGORIA,
  ACOES_POR_RELEVANCIA,
  alteracaoEmTexto,
  auditoriaQuerySchema,
  categoriaValida,
  formatarDetalhesAuditoria,
  relevanciaValida,
  resolverPaginacao,
  traduzirAcao,
  traduzirRecurso,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";

interface AuditoriaRow {
  id: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  usuario_perfil: string | null;
  acao: string;
  entidade: string;
  entidade_id: string | null;
  detalhes: string | null;
  criado_em: Date;
  // Projeção do recurso — ver SELECT_AUDITORIA. Resolvida por LEFT JOIN em chave
  // primária, não por consulta extra: sem isto o frontend teria que buscar o nome de
  // cada plataforma/reserva linha a linha (N+1) só para deixar de exibir um UUID.
  recurso_nome: string | null;
  recurso_codigo: string | null;
  recurso_contexto: string | null;
}

function mapAuditoria(row: AuditoriaRow) {
  return {
    id: row.id,
    usuarioId: row.usuario_id,
    usuarioNome: row.usuario_nome,
    acao: row.acao,
    entidade: row.entidade,
    entidadeId: row.entidade_id,
    // Defesa em profundidade: hoje a constraint CK_LogAuditoria_detalhes_json (migration
    // 0001) garante JSON válido nesta coluna, então JSON.parse não quebra. Mas a garantia
    // vive só no banco — se a constraint for removida numa migration futura, ou se um
    // dump/importação trouxer uma linha fora do padrão, um único registro inválido faria
    // a consulta inteira responder 500, justamente na tela usada para investigar
    // incidentes. Preservar o texto cru custa nada e remove esse ponto único de falha.
    detalhes: interpretarDetalhes(row.detalhes),
    criadoEm: row.criado_em,
    usuarioPerfil: row.usuario_perfil,
    // O nome atual do recurso. O snapshot histórico (quando existe) continua dentro de
    // `detalhes` e tem precedência na UI — ver identificarRecurso no AuditoriaClient:
    // se uma plataforma for renomeada, a auditoria deve poder mostrar como ela era
    // identificada no momento da ação, não só como se chama hoje.
    recursoNome: row.recurso_nome,
    recursoCodigo: row.recurso_codigo,
    recursoContexto: row.recurso_contexto,
  };
}

function interpretarDetalhes(detalhes: string | null): unknown {
  if (!detalhes) return null;
  try {
    return JSON.parse(detalhes);
  } catch {
    return detalhes;
  }
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

// Mesmo vocabulário de VALORES_AUDITORIA.perfil, sem precisar carregar o mapa inteiro
// para três chaves.
const PERFIS_CSV: Record<string, string> = {
  admin: "Administrador",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

function escaparCampoCsv(valor: string): string {
  return `"${valor.replace(/"/g, '""')}"`;
}

// RF-AUD-01/02 (S12): consulta e exportação do LogAuditoria (persistido desde S1,
// nunca lido via API até esta sprint). Admin only — auditoria é informação sensível
// sobre a atividade de todos os usuários do sistema.
/**
 * Expande um filtro de agrupamento (categoria/importância) para o `IN (...)` de ações
 * correspondente. A classificação vive no catálogo em @plataformares/shared — a mesma
 * fonte que nomeia os eventos na tela —, então nunca há duas listas para manter em
 * sincronia. Os valores entram como parâmetros nomeados, nunca interpolados.
 */
function filtrarPorGrupoDeAcoes(
  dbRequest: sql.Request,
  prefixo: string,
  acoes: string[] | undefined
): string {
  if (!acoes || acoes.length === 0) return "";
  const nomes = acoes.map((acao, indice) => {
    const parametro = `${prefixo}_${indice}`;
    dbRequest.input(parametro, sql.VarChar, acao);
    return `@${parametro}`;
  });
  return ` AND la.acao IN (${nomes.join(", ")})`;
}

function montarWhereAuditoria(
  dbRequest: sql.Request,
  filtros: {
    usuarioId?: string;
    acao?: string;
    entidade?: string;
    categoria?: string;
    relevancia?: string;
    dateFrom?: string;
    dateTo?: string;
  }
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
  // Categoria e importância são agrupamentos de apresentação, não colunas: precisam ser
  // resolvidos no servidor porque a listagem é paginada no banco — filtrar no cliente
  // encolheria apenas a página atual e faria o total exibido mentir.
  if (filtros.categoria && categoriaValida(filtros.categoria)) {
    where += filtrarPorGrupoDeAcoes(dbRequest, "cat", ACOES_POR_CATEGORIA[filtros.categoria]);
  }
  if (filtros.relevancia && relevanciaValida(filtros.relevancia)) {
    where += filtrarPorGrupoDeAcoes(dbRequest, "rel", ACOES_POR_RELEVANCIA[filtros.relevancia]);
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

/* Projeção do recurso auditado.
 *
 * O log guarda só `entidade` + `entidade_id` (UUID). Exibir o UUID como identificação
 * principal é inútil para quem audita — a pergunta real é "qual plataforma?", "qual
 * reserva?". Estes JOINs respondem isso no próprio SELECT, sobre a janela paginada:
 * todos são por chave primária, e nenhum multiplica linhas (relação 1:1).
 *
 * Cada JOIN é condicionado à entidade correspondente para que uma linha de Plataforma
 * não tente casar o seu id com a tabela Reserva.
 */
const SELECT_AUDITORIA = `
  la.id, la.usuario_id, u.nome AS usuario_nome, u.perfil AS usuario_perfil,
  la.acao, la.entidade, la.entidade_id, la.detalhes, la.criado_em,
  COALESCE(p.nome, rp.nome, ua.nome, se.nome, ct.nome) AS recurso_nome,
  COALESCE(p.codigo, rp.codigo) AS recurso_codigo,
  CASE
    -- Uma reserva é identificada pelo equipamento e pela janela: é o que permite
    -- reconhecê-la sem abrir o detalhe.
    WHEN la.entidade = 'Reserva' AND r.id IS NOT NULL
      THEN CONVERT(varchar(10), r.data, 103) + ' ' + CONVERT(varchar(5), r.hora_inicio, 108)
    WHEN la.entidade = 'Usuario' THEN ua.email
    WHEN la.entidade = 'Plataforma' THEN p.localizacao
    ELSE NULL
  END AS recurso_contexto`;
const FROM_AUDITORIA = `FROM LogAuditoria la
  LEFT JOIN Usuario u ON u.id = la.usuario_id
  LEFT JOIN Reserva r ON la.entidade = 'Reserva' AND r.id = la.entidade_id
  LEFT JOIN Plataforma rp ON rp.id = r.plataforma_id
  LEFT JOIN Plataforma p ON la.entidade = 'Plataforma' AND p.id = la.entidade_id
  LEFT JOIN Usuario ua ON la.entidade = 'Usuario' AND ua.id = la.entidade_id
  LEFT JOIN Setor se ON la.entidade = 'Setor' AND se.id = la.entidade_id
  LEFT JOIN ChecklistTemplate ct ON la.entidade = 'ChecklistTemplate' AND ct.id = la.entidade_id`;

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

      // Antes: `TOP 500` fixo, que truncava silenciosamente — o Admin não tinha como
      // saber que existiam mais registros além dos exibidos, nem como alcançá-los.
      // Agora a janela é explícita e o total real vai no header X-Total-Count.
      const { limit, offset } = resolverPaginacao(parsed.data);
      dbRequest.input("limit", sql.Int, limit).input("offset", sql.Int, offset);
      const result = await dbRequest.query<AuditoriaRow & { total_geral: number }>(
        `SELECT ${SELECT_AUDITORIA}, COUNT(*) OVER() AS total_geral ${FROM_AUDITORIA} ${where}
         ORDER BY la.criado_em DESC, la.id
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
      );
      const total = result.recordset[0]?.total_geral ?? 0;
      return reply
        .header("X-Total-Count", String(total))
        .header("X-Limit", String(limit))
        .header("X-Offset", String(offset))
        .status(200)
        .send(result.recordset.map(mapAuditoria));
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

      // O CSV usa os MESMOS formatadores da tela (@plataformares/shared): o evento que o
      // Admin leu como "Reserva aprovada" chega à planilha com esse nome, não como
      // "aprovar_reserva" nem como uma terceira variação inventada aqui.
      //
      // As colunas humanas vêm primeiro porque são o uso real do arquivo (relatório,
      // evidência de conformidade); as técnicas ficam ao final, preservadas na íntegra
      // para investigação e suporte — inclusive o payload JSON cru.
      const cabecalho = [
        "Data/Hora",
        "Responsável",
        "Perfil",
        "Evento",
        "Categoria",
        "Recurso",
        "Identificação do recurso",
        "Alteração",
        "Código interno do evento",
        "Tipo técnico",
        "ID técnico",
        "Payload",
      ];
      const linhas = result.recordset.map((row) => {
        const meta = traduzirAcao(row.acao);
        const alteracao = alteracaoEmTexto(
          formatarDetalhesAuditoria(row.acao, interpretarDetalhes(row.detalhes) as Record<string, unknown>, {
            entidade: row.entidade,
          })
        );
        const identificacao = [row.recurso_codigo, row.recurso_nome].filter(Boolean).join(" · ");
        return [
          formatarDataHoraBr(row.criado_em),
          escaparCampoCsv(row.usuario_nome ?? "Sistema"),
          row.usuario_nome ? PERFIS_CSV[row.usuario_perfil ?? ""] ?? "" : "Ação automática",
          escaparCampoCsv(meta.titulo),
          meta.categoria,
          traduzirRecurso(row.entidade),
          escaparCampoCsv(identificacao),
          escaparCampoCsv(alteracao),
          row.acao,
          row.entidade,
          row.entidade_id ?? "",
          escaparCampoCsv(row.detalhes ?? ""),
        ].join(";");
      });
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
