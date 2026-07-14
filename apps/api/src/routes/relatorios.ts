import type { FastifyInstance } from "fastify";
import {
  exportarRelatorioQuerySchema,
  relatorioQuerySchema,
  CATEGORIAS_PLATAFORMA,
  PRIORIDADES_RESERVA,
  STATUS_RESERVA,
  type CategoriaPlataforma,
  type PrioridadeReserva,
  type RankingSetoresResposta,
  type SegurancaResposta,
  type SlaAprovacaoResposta,
  type StatusReserva,
  type UtilizacaoResposta,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import {
  calcularIndicadoresSeguranca,
  calcularRankingSetores,
  calcularTempoMedioAprovacaoHoras,
  calcularTendenciaMensal,
  calcularUtilizacaoPlataformas,
  contarPorChave,
  janelaSqlDoPeriodo,
  type BloqueioIntervalo,
  type ChecklistResumo,
  type DecisaoAprovacao,
  type OcorrenciaResumo,
  type PlataformaResumo,
  type ReservaDuracao,
  type SetorResumo,
} from "../services/relatorio.service.js";
import { obterOuCalcularRelatorio, type ChaveCacheRelatorio } from "../services/relatorioCache.service.js";
import { gerarExcelRelatorio, gerarPdfRelatorio, type DadosRelatorio } from "../services/relatorioExport.service.js";

interface UsuarioSessaoRelatorio {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

// RF-REL-01/03/04/06 (SDD §6.7): Gestor de Setor é sempre restrito ao próprio setor,
// mesmo que envie ?setor=<outro> — só o Admin pode filtrar por um setor arbitrário ou
// ver o agregado global (setor=null). Mesmo padrão de RF-HIST-01 (historico.ts).
function resolverEscopoSetor(usuario: UsuarioSessaoRelatorio, setorQuery: string | undefined): string | null {
  if (usuario.perfil === "admin") {
    return setorQuery ?? null;
  }
  return usuario.setorId;
}

function periodoOrigem(dateFrom: string, dateTo: string) {
  return { inicio: dateFrom, fim: dateTo };
}

// ---------------------------------------------------------------------------
// RF-REL-01 — GET /relatorios/utilizacao
// ---------------------------------------------------------------------------

async function buscarUtilizacao(
  dateFrom: string,
  dateTo: string,
  escopoSetorId: string | null
): Promise<UtilizacaoResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  const plataformasResult = await pool
    .request()
    .query<{ id: string; codigo: string; nome: string; categoria: CategoriaPlataforma }>(
      "SELECT id, codigo, nome, categoria FROM Plataforma ORDER BY nome"
    );

  const reservasRequest = pool.request().input("date_from", sql.Date, dateFrom).input("date_to", sql.Date, dateTo);
  let whereSetor = "";
  if (escopoSetorId) {
    reservasRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    whereSetor = " AND setor_id = @setor_id";
  }
  const reservasResult = await reservasRequest.query<{
    plataforma_id: string;
    data: string;
    hora_inicio: string;
    hora_fim: string;
    status: StatusReserva;
  }>(
    `SELECT plataforma_id,
            CONVERT(varchar(10), data, 23) AS data,
            CONVERT(varchar(5), hora_inicio, 108) AS hora_inicio,
            CONVERT(varchar(5), hora_fim, 108) AS hora_fim,
            status
     FROM Reserva
     WHERE data >= @date_from AND data <= @date_to${whereSetor}`
  );

  const bloqueiosResult = await pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo)
    .query<{ plataforma_id: string | null; data_inicio: Date; data_fim: Date }>(
      `SELECT plataforma_id, data_inicio, data_fim
       FROM BloqueioAgenda
       WHERE data_inicio < @fim_exclusivo AND data_fim > @inicio`
    );

  const plataformas: PlataformaResumo[] = plataformasResult.recordset.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nome: p.nome,
    categoria: p.categoria,
  }));
  const reservas: ReservaDuracao[] = reservasResult.recordset.map((r) => ({
    plataformaId: r.plataforma_id,
    data: r.data,
    horaInicio: r.hora_inicio,
    horaFim: r.hora_fim,
    status: r.status,
  }));
  const bloqueios: BloqueioIntervalo[] = bloqueiosResult.recordset.map((b) => ({
    plataformaId: b.plataforma_id,
    dataInicio: b.data_inicio,
    dataFim: b.data_fim,
  }));

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    plataformas: calcularUtilizacaoPlataformas(plataformas, reservas, bloqueios, periodo),
  };
}

// ---------------------------------------------------------------------------
// RF-REL-02 — GET /relatorios/ranking-setores (Admin only, global)
// ---------------------------------------------------------------------------

async function buscarRankingSetores(dateFrom: string, dateTo: string): Promise<RankingSetoresResposta> {
  const pool = await getPool();

  const setoresResult = await pool
    .request()
    .query<{ id: string; nome: string; cor_hex: string }>("SELECT id, nome, cor_hex FROM Setor WHERE ativo = 1 ORDER BY nome");

  const reservasResult = await pool
    .request()
    .input("date_from", sql.Date, dateFrom)
    .input("date_to", sql.Date, dateTo)
    .query<{ setor_id: string; status: StatusReserva }>(
      "SELECT setor_id, status FROM Reserva WHERE data >= @date_from AND data <= @date_to"
    );

  const setores: SetorResumo[] = setoresResult.recordset.map((s) => ({ id: s.id, nome: s.nome, corHex: s.cor_hex }));

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    setores: calcularRankingSetores(setores, reservasResult.recordset.map((r) => ({ setorId: r.setor_id, status: r.status }))),
  };
}

// ---------------------------------------------------------------------------
// RF-REL-03/04 — GET /relatorios/sla-aprovacao
// ---------------------------------------------------------------------------

async function buscarSlaAprovacao(
  dateFrom: string,
  dateTo: string,
  escopoSetorId: string | null
): Promise<SlaAprovacaoResposta> {
  const pool = await getPool();

  // O período do relatório sempre filtra pela DATA DE USO da reserva (Reserva.data —
  // mesmo campo usado por /utilizacao e /ranking-setores), não pela data de criação:
  // é o que o usuário efetivamente escolhe no seletor de período da tela. O tempo médio
  // de aprovação (RF-REL-03) e a tendência mensal (RF-REL-04) continuam medidos/agrupados
  // por criado_em/decidido_em — só a SELEÇÃO do conjunto de reservas usa `data`.
  const reservasRequest = pool.request().input("date_from", sql.Date, dateFrom).input("date_to", sql.Date, dateTo);
  let whereSetor = "";
  if (escopoSetorId) {
    reservasRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    whereSetor = " AND r.setor_id = @setor_id";
  }
  // RF-REL-03: decidido_em = a ÚLTIMA de "aprovar_reserva"/"rejeitar_reserva" registrada
  // em LogAuditoria para a reserva (cobre dupla aprovação — S7: a decisão FINAL é o que
  // conta, não a primeira aprovação do Gestor que ainda deixa a reserva "pendente").
  const reservasResult = await reservasRequest.query<{
    id: string;
    criado_em: Date;
    status: StatusReserva;
    prioridade: PrioridadeReserva;
    plataforma_categoria: CategoriaPlataforma;
    decidido_em: Date | null;
  }>(
    `SELECT r.id, r.criado_em, r.status, r.prioridade, p.categoria AS plataforma_categoria,
            (SELECT MAX(la.criado_em) FROM LogAuditoria la
             WHERE la.entidade = 'Reserva' AND la.entidade_id = r.id
               AND la.acao IN ('aprovar_reserva', 'rejeitar_reserva')) AS decidido_em
     FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE r.data >= @date_from AND r.data <= @date_to${whereSetor}`
  );

  const linhas = reservasResult.recordset;
  const decisoes: DecisaoAprovacao[] = linhas
    .filter((r) => r.decidido_em !== null)
    .map((r) => ({ criadoEm: r.criado_em, decididoEm: r.decidido_em as Date }));

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    tempoMedioAprovacaoHoras: calcularTempoMedioAprovacaoHoras(decisoes),
    totalDecisoes: decisoes.length,
    porStatus: contarPorChave(linhas.map((r) => r.status) as StatusReserva[], STATUS_RESERVA),
    porPrioridade: contarPorChave(linhas.map((r) => r.prioridade) as PrioridadeReserva[], PRIORIDADES_RESERVA),
    porCategoria: contarPorChave(linhas.map((r) => r.plataforma_categoria) as CategoriaPlataforma[], CATEGORIAS_PLATAFORMA),
    tendenciaMensal: calcularTendenciaMensal(linhas.map((r) => r.criado_em)),
  };
}

// ---------------------------------------------------------------------------
// RF-REL-05 — GET /relatorios/seguranca (Admin only, global — SDD §6.7)
// ---------------------------------------------------------------------------

async function buscarSeguranca(dateFrom: string, dateTo: string): Promise<SegurancaResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  const checklistsResult = await pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo)
    .query<{ todos_conformes: boolean }>(
      "SELECT todos_conformes FROM ChecklistPreenchido WHERE preenchido_em >= @inicio AND preenchido_em < @fim_exclusivo"
    );

  const ocorrenciasResult = await pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo)
    .query<{ plataforma_id: string; plataforma_nome: string; gravidade: "baixa" | "media" | "alta" }>(
      `SELECT o.plataforma_id, p.nome AS plataforma_nome, o.gravidade
       FROM Ocorrencia o JOIN Plataforma p ON p.id = o.plataforma_id
       WHERE o.criado_em >= @inicio AND o.criado_em < @fim_exclusivo`
    );

  const checklists: ChecklistResumo[] = checklistsResult.recordset.map((c) => ({ todosConformes: !!c.todos_conformes }));
  const ocorrencias: OcorrenciaResumo[] = ocorrenciasResult.recordset.map((o) => ({
    plataformaId: o.plataforma_id,
    plataformaNome: o.plataforma_nome,
    gravidade: o.gravidade,
  }));

  const calculado = calcularIndicadoresSeguranca(checklists, ocorrencias);
  return { periodo: periodoOrigem(dateFrom, dateTo), ...calculado };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export async function relatoriosRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/relatorios/utilizacao",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const escopoSetorId = resolverEscopoSetor(request.usuario!, parsed.data.setor);
      const chave: ChaveCacheRelatorio = { relatorio: "utilizacao", dateFrom: parsed.data.dateFrom, dateTo: parsed.data.dateTo, escopoSetorId };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarUtilizacao(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  app.get(
    "/api/v1/relatorios/ranking-setores",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const chave: ChaveCacheRelatorio = {
        relatorio: "ranking-setores",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId: null,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarRankingSetores(parsed.data.dateFrom, parsed.data.dateTo)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  app.get(
    "/api/v1/relatorios/sla-aprovacao",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const escopoSetorId = resolverEscopoSetor(request.usuario!, parsed.data.setor);
      const chave: ChaveCacheRelatorio = { relatorio: "sla-aprovacao", dateFrom: parsed.data.dateFrom, dateTo: parsed.data.dateTo, escopoSetorId };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarSlaAprovacao(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  app.get(
    "/api/v1/relatorios/seguranca",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const chave: ChaveCacheRelatorio = {
        relatorio: "seguranca",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId: null,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarSeguranca(parsed.data.dateFrom, parsed.data.dateTo)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  // RF-REL-06: exportação de qualquer um dos 4 relatórios em PDF ou Excel. Passa pelo
  // MESMO cache das rotas de leitura acima (mesma chave relatório+período+escopo) —
  // exportar duas vezes seguidas dentro do TTL não repete a agregação SQL.
  app.get(
    "/api/v1/relatorios/export",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = exportarRelatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const { relatorio, formato, dateFrom, dateTo, setor } = parsed.data;
      const usuario = request.usuario!;

      // RF-REL-02/05 (SDD §6.7): ranking-setores e segurança são Admin only, mesmo via export.
      if ((relatorio === "ranking-setores" || relatorio === "seguranca") && usuario.perfil !== "admin") {
        return reply.status(403).send({ erro: "Apenas o Admin pode exportar este relatório." });
      }

      const escopoSetorId = relatorio === "ranking-setores" || relatorio === "seguranca" ? null : resolverEscopoSetor(usuario, setor);
      const chave: ChaveCacheRelatorio = { relatorio, dateFrom, dateTo, escopoSetorId };

      let dados: DadosRelatorio;
      if (relatorio === "utilizacao") {
        const { valor } = await obterOuCalcularRelatorio(chave, () => buscarUtilizacao(dateFrom, dateTo, escopoSetorId));
        dados = { relatorio: "utilizacao", dados: valor };
      } else if (relatorio === "ranking-setores") {
        const { valor } = await obterOuCalcularRelatorio(chave, () => buscarRankingSetores(dateFrom, dateTo));
        dados = { relatorio: "ranking-setores", dados: valor };
      } else if (relatorio === "sla-aprovacao") {
        const { valor } = await obterOuCalcularRelatorio(chave, () => buscarSlaAprovacao(dateFrom, dateTo, escopoSetorId));
        dados = { relatorio: "sla-aprovacao", dados: valor };
      } else {
        const { valor } = await obterOuCalcularRelatorio(chave, () => buscarSeguranca(dateFrom, dateTo));
        dados = { relatorio: "seguranca", dados: valor };
      }

      const nomeBase = `relatorio_${relatorio}_${dateFrom}_a_${dateTo}`;
      if (formato === "excel") {
        const buffer = await gerarExcelRelatorio(dados);
        return reply
          .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .header("Content-Disposition", `attachment; filename="${nomeBase}.xlsx"`)
          .status(200)
          .send(buffer);
      }
      const buffer = await gerarPdfRelatorio(dados, periodoOrigem(dateFrom, dateTo));
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${nomeBase}.pdf"`)
        .status(200)
        .send(buffer);
    }
  );
}
