import type { FastifyInstance } from "fastify";
import {
  exportarRelatorioQuerySchema,
  relatorioQuerySchema,
  CATEGORIAS_PLATAFORMA,
  PRIORIDADES_RESERVA,
  STATUS_RESERVA,
  type BloqueiosRelatorioResposta,
  type CategoriaPlataforma,
  type ChecklistsRelatorioResposta,
  type NaoConformidadesRelatorioResposta,
  type OperacionalResposta,
  type PrioridadeReserva,
  type RankingSetoresResposta,
  type SegurancaResposta,
  type SlaAprovacaoResposta,
  type StatusReserva,
  type UtilizacaoResposta,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { SQL_PLATAFORMA_EXIGE_CHECKLIST } from "../services/checklist.service.js";
import {
  calcularChecklistsPorCategoria,
  calcularChecklistsPorSetor,
  calcularDemandaPorHora,
  calcularEvolucaoConformidade,
  calcularEvolucaoDiaria,
  calcularEvolucaoNaoConformidades,
  calcularIndicadoresBloqueios,
  calcularIndicadoresSeguranca,
  calcularItensChecklistCriticos,
  calcularKpisNaoConformidades,
  calcularNaoConformidadePorPlataforma,
  calcularNaoConformidadesPorPlataforma,
  calcularNaoConformidadesPorSetor,
  calcularNaoConformidadesPorStatus,
  calcularRankingPlataformas,
  calcularRankingSetores,
  calcularRelacaoReservaChecklist,
  calcularTaxasChecklist,
  calcularTempoMedioAprovacaoHoras,
  calcularTempoMedioConclusaoChecklistHoras,
  calcularTendenciaMensal,
  calcularTotaisOperacionais,
  calcularUtilizacaoPlataformas,
  contarPorChave,
  janelaSqlDoPeriodo,
  type BloqueioComMotivo,
  type BloqueioIntervalo,
  type ChecklistFinalizado,
  type ChecklistResumo,
  type DecisaoAprovacao,
  type NaoConformidadeResumo,
  type OcorrenciaResumo,
  type PlataformaResumo,
  type ReservaChecklistResumo,
  type ReservaDuracao,
  type ReservaOperacional,
  type RespostaNaoConformeResumo,
  type SetorResumo,
} from "../services/relatorio.service.js";
import { obterOuCalcularRelatorio, type ChaveCacheRelatorio } from "../services/relatorioCache.service.js";
import { gerarExcelRelatorio, gerarPdfRelatorio, type DadosRelatorio } from "../services/relatorioExport.service.js";

interface UsuarioSessaoRelatorio {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

// Relatórios são leitura GERENCIAL global para Admin e Gestor: o padrão é o agregado de
// todos os setores (null) e ?setor= é um filtro EXPLÍCITO opcional. Antes o Gestor era
// preso ao próprio setor mesmo enviando ?setor=<outro> — filtro invisível que escondia o
// resto da operação de quem também aprova reservas de qualquer setor. Colaborador não chega
// aqui (requireRole). Isto só amplia LEITURA de relatórios; nenhuma outra permissão muda.
function resolverEscopoSetor(usuario: UsuarioSessaoRelatorio, setorQuery: string | undefined): string | null {
  if (usuario.perfil === "admin" || usuario.perfil === "gestor_setor") {
    return setorQuery ?? null;
  }
  return usuario.setorId;
}

// Filtros globais adicionais da expansão de Relatórios (PARTE 10) — plataforma específica
// e/ou categoria de plataforma, aplicados via WHERE condicional nas queries que já juntam
// Plataforma. `aliasPlataforma` é o alias SQL da tabela Plataforma naquela query.
interface FiltrosPlataforma {
  plataforma?: string;
  categoria?: CategoriaPlataforma;
}

function aplicarFiltrosPlataforma(dbRequest: sql.Request, aliasPlataforma: string, filtros: FiltrosPlataforma): string {
  let where = "";
  if (filtros.plataforma) {
    dbRequest.input("plataforma_filtro", sql.UniqueIdentifier, filtros.plataforma);
    where += ` AND ${aliasPlataforma}.id = @plataforma_filtro`;
  }
  if (filtros.categoria) {
    dbRequest.input("categoria_filtro", sql.VarChar, filtros.categoria);
    where += ` AND ${aliasPlataforma}.categoria = @categoria_filtro`;
  }
  return where;
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
  escopoSetorId: string | null,
  filtros: FiltrosPlataforma = {}
): Promise<UtilizacaoResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  const plataformasRequest = pool.request();
  const wherePlataforma = aplicarFiltrosPlataforma(plataformasRequest, "Plataforma", filtros).replace(
    /^ AND /,
    "WHERE "
  );
  const plataformasResult = await plataformasRequest.query<{
    id: string;
    codigo: string;
    nome: string;
    categoria: CategoriaPlataforma;
  }>(`SELECT id, codigo, nome, categoria FROM Plataforma ${wherePlataforma} ORDER BY nome`);

  const reservasRequest = pool.request().input("date_from", sql.Date, dateFrom).input("date_to", sql.Date, dateTo);
  let whereSetor = "";
  if (escopoSetorId) {
    reservasRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    whereSetor = " AND setor_id = @setor_id";
  }
  const reservasResult = await reservasRequest.query<{
    plataforma_id: string;
    data: string;
    data_fim: string;
    hora_inicio: string;
    hora_fim: string;
    status: StatusReserva;
  }>(
    // Sobreposição com o período (migration 0029): reserva de vários dias que começou antes
    // ou termina depois do intervalo entra, e a parte fora dele é recortada no cálculo.
    `SELECT plataforma_id,
            CONVERT(varchar(10), data, 23) AS data,
            CONVERT(varchar(10), data_fim, 23) AS data_fim,
            CONVERT(varchar(5), hora_inicio, 108) AS hora_inicio,
            CONVERT(varchar(5), hora_fim, 108) AS hora_fim,
            status
     FROM Reserva
     WHERE data_fim >= @date_from AND data <= @date_to${whereSetor}`
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
    dataFim: r.data_fim,
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
      "SELECT setor_id, status FROM Reserva WHERE data_fim >= @date_from AND data <= @date_to"
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
  escopoSetorId: string | null,
  filtros: FiltrosPlataforma = {}
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
  whereSetor += aplicarFiltrosPlataforma(reservasRequest, "p", filtros);
  // RF-REL-03: decidido_em = a ÚLTIMA de "aprovar_reserva"/"rejeitar_reserva" registrada
  // em LogAuditoria para a reserva (cobre dupla aprovação — S7: a decisão FINAL é o que
  // conta, não a primeira aprovação do Gestor que ainda deixa a reserva "pendente").
  // decisao_acao (PARTE 27/28) — qual das duas ações foi essa última decisão, para separar
  // aprovadas de rejeitadas sem depender do status atual (que já pode ter avançado).
  const reservasResult = await reservasRequest.query<{
    id: string;
    criado_em: Date;
    status: StatusReserva;
    prioridade: PrioridadeReserva;
    plataforma_categoria: CategoriaPlataforma;
    decidido_em: Date | null;
    decisao_acao: "aprovar_reserva" | "rejeitar_reserva" | null;
  }>(
    `SELECT r.id, r.criado_em, r.status, r.prioridade, p.categoria AS plataforma_categoria,
            (SELECT MAX(la.criado_em) FROM LogAuditoria la
             WHERE la.entidade = 'Reserva' AND la.entidade_id = r.id
               AND la.acao IN ('aprovar_reserva', 'rejeitar_reserva')) AS decidido_em,
            (SELECT TOP 1 la.acao FROM LogAuditoria la
             WHERE la.entidade = 'Reserva' AND la.entidade_id = r.id
               AND la.acao IN ('aprovar_reserva', 'rejeitar_reserva')
             ORDER BY la.criado_em DESC) AS decisao_acao
     FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE r.data_fim >= @date_from AND r.data <= @date_to${whereSetor}`
  );

  const linhas = reservasResult.recordset;
  const decisoes: DecisaoAprovacao[] = linhas
    .filter((r) => r.decidido_em !== null)
    .map((r) => ({ criadoEm: r.criado_em, decididoEm: r.decidido_em as Date }));
  const totalAprovadas = linhas.filter((r) => r.decisao_acao === "aprovar_reserva").length;
  const totalRejeitadas = linhas.filter((r) => r.decisao_acao === "rejeitar_reserva").length;
  const totalDecididas = totalAprovadas + totalRejeitadas;

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    tempoMedioAprovacaoHoras: calcularTempoMedioAprovacaoHoras(decisoes),
    totalDecisoes: decisoes.length,
    totalAprovadas,
    totalRejeitadas,
    taxaAprovacao: totalDecididas > 0 ? Math.round((totalAprovadas / totalDecididas) * 10000) / 100 : 0,
    taxaRejeicao: totalDecididas > 0 ? Math.round((totalRejeitadas / totalDecididas) * 10000) / 100 : 0,
    pendentesAtuais: linhas.filter((r) => r.status === "pendente").length,
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

  // Bug corrigido: filtrava por preenchido_em (reescrito a cada rascunho salvo, e incluía
  // checklists ainda não finalizados) — a % de não conformidade misturava rascunhos com
  // checklists de verdade concluídos. finalizado_em só existe em checklists finalizados.
  const checklistsResult = await pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo)
    .query<{ todos_conformes: boolean }>(
      `SELECT todos_conformes FROM ChecklistPreenchido
       WHERE finalizado_em IS NOT NULL AND finalizado_em >= @inicio AND finalizado_em < @fim_exclusivo`
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
// Expansão de Relatórios & Indicadores — GET /relatorios/operacional
// (Visão Geral + Uso da Frota)
// ---------------------------------------------------------------------------

async function buscarOperacional(
  dateFrom: string,
  dateTo: string,
  escopoSetorId: string | null,
  filtros: FiltrosPlataforma = {}
): Promise<OperacionalResposta> {
  const periodo = { dateFrom, dateTo };
  const pool = await getPool();

  const plataformasRequest = pool.request();
  const wherePlataforma = aplicarFiltrosPlataforma(plataformasRequest, "Plataforma", filtros).replace(
    /^ AND /,
    "WHERE "
  );
  const plataformasResult = await plataformasRequest.query<{
    id: string;
    codigo: string;
    nome: string;
    categoria: CategoriaPlataforma;
  }>(`SELECT id, codigo, nome, categoria FROM Plataforma ${wherePlataforma} ORDER BY nome`);

  const reservasRequest = pool.request().input("date_from", sql.Date, dateFrom).input("date_to", sql.Date, dateTo);
  let where = "";
  if (escopoSetorId) {
    reservasRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    where += " AND r.setor_id = @setor_id";
  }
  where += aplicarFiltrosPlataforma(reservasRequest, "p", filtros);
  const reservasResult = await reservasRequest.query<{
    plataforma_id: string;
    data: string;
    data_fim: string;
    hora_inicio: string;
    hora_fim: string;
    status: StatusReserva;
  }>(
    `SELECT r.plataforma_id,
            CONVERT(varchar(10), r.data, 23) AS data,
            CONVERT(varchar(10), r.data_fim, 23) AS data_fim,
            CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
            CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
            r.status
     FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE r.data_fim >= @date_from AND r.data <= @date_to${where}`
  );

  const plataformas: PlataformaResumo[] = plataformasResult.recordset.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nome: p.nome,
    categoria: p.categoria,
  }));
  const reservas: ReservaOperacional[] = reservasResult.recordset.map((r) => ({
    plataformaId: r.plataforma_id,
    data: r.data,
    dataFim: r.data_fim,
    horaInicio: r.hora_inicio,
    horaFim: r.hora_fim,
    status: r.status,
  }));

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    ...calcularTotaisOperacionais(reservas),
    evolucaoDiaria: calcularEvolucaoDiaria(reservas, periodo),
    demandaPorHora: calcularDemandaPorHora(reservas),
    rankingPlataformas: calcularRankingPlataformas(plataformas, reservas),
  };
}

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/bloqueios
// (Indisponibilidade)
// ---------------------------------------------------------------------------

async function buscarBloqueiosRelatorio(
  dateFrom: string,
  dateTo: string,
  filtros: FiltrosPlataforma = {}
): Promise<BloqueiosRelatorioResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  const dbRequest = pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo);
  let where = "b.data_inicio < @fim_exclusivo AND b.data_fim > @inicio";
  // Filtro de plataforma: um bloqueio GLOBAL (plataforma_id NULL) sempre atinge qualquer
  // plataforma filtrada, então continua incluído. Categoria não é filtrável aqui — um
  // bloqueio global não tem categoria própria e a semântica ficaria ambígua.
  if (filtros.plataforma) {
    dbRequest.input("plataforma_filtro", sql.UniqueIdentifier, filtros.plataforma);
    where += " AND (b.plataforma_id = @plataforma_filtro OR b.plataforma_id IS NULL)";
  }
  const bloqueiosResult = await dbRequest.query<{
    plataforma_id: string | null;
    data_inicio: Date;
    data_fim: Date;
    motivo: string;
  }>(`SELECT b.plataforma_id, b.data_inicio, b.data_fim, b.motivo FROM BloqueioAgenda b WHERE ${where}`);

  const bloqueios: BloqueioComMotivo[] = bloqueiosResult.recordset.map((b) => ({
    plataformaId: b.plataforma_id,
    dataInicio: b.data_inicio,
    dataFim: b.data_fim,
    motivo: b.motivo,
  }));

  const calculado = calcularIndicadoresBloqueios(bloqueios, periodo);
  return { periodo: periodoOrigem(dateFrom, dateTo), ...calculado };
}

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/checklists
// (Segurança & Checklists)
// ---------------------------------------------------------------------------

async function buscarChecklistsRelatorio(
  dateFrom: string,
  dateTo: string,
  escopoSetorId: string | null,
  filtros: FiltrosPlataforma = {}
): Promise<ChecklistsRelatorioResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  // 1) Toda reserva do período (para a relação reserva↔checklist — PARTE 26) — mesma
  // seleção por Reserva.data usada pelos demais relatórios.
  const reservasRequest = pool.request().input("date_from", sql.Date, dateFrom).input("date_to", sql.Date, dateTo);
  let whereReservas = "";
  if (escopoSetorId) {
    reservasRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    whereReservas += " AND r.setor_id = @setor_id";
  }
  whereReservas += aplicarFiltrosPlataforma(reservasRequest, "p", filtros);
  const reservasResult = await reservasRequest.query<{
    status: StatusReserva;
    requer_checklist: boolean;
    checklist_finalizado: boolean;
  }>(
    `SELECT r.status, ${SQL_PLATAFORMA_EXIGE_CHECKLIST} AS requer_checklist,
            CAST(CASE WHEN EXISTS (
              SELECT 1 FROM ChecklistPreenchido cp WHERE cp.reserva_id = r.id AND cp.finalizado_em IS NOT NULL
            ) THEN 1 ELSE 0 END AS BIT) AS checklist_finalizado
     FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE r.data_fim >= @date_from AND r.data <= @date_to${whereReservas}`
  );
  const reservasChecklist: ReservaChecklistResumo[] = reservasResult.recordset.map((r) => ({
    status: r.status,
    requerChecklist: !!r.requer_checklist,
    checklistFinalizado: !!r.checklist_finalizado,
  }));

  // 2) Checklists FINALIZADOS no período (finalizado_em, não preenchido_em — mesma
  // correção aplicada em buscarSeguranca), com plataforma/categoria/setor e o instante de
  // início reconstruído via LogAuditoria (PARTE 25).
  const finalizadosRequest = pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo);
  let whereFinalizados = "cp.finalizado_em >= @inicio AND cp.finalizado_em < @fim_exclusivo";
  if (escopoSetorId) {
    finalizadosRequest.input("setor_id_f", sql.UniqueIdentifier, escopoSetorId);
    whereFinalizados += " AND r.setor_id = @setor_id_f";
  }
  whereFinalizados += aplicarFiltrosPlataforma(finalizadosRequest, "p", filtros);
  const finalizadosResult = await finalizadosRequest.query<{
    plataforma_id: string;
    plataforma_nome: string;
    categoria: CategoriaPlataforma;
    setor_id: string;
    setor_nome: string;
    finalizado_em: Date;
    todos_conformes: boolean;
    inicio_em: Date | null;
  }>(
    `SELECT r.plataforma_id, p.nome AS plataforma_nome, p.categoria, r.setor_id, s.nome AS setor_nome,
            cp.finalizado_em, cp.todos_conformes,
            (SELECT MIN(la.criado_em) FROM LogAuditoria la
             WHERE la.entidade = 'Reserva' AND la.entidade_id = r.id
               AND la.acao IN ('salvar_rascunho_checklist', 'finalizar_checklist')) AS inicio_em
     FROM ChecklistPreenchido cp
     JOIN Reserva r ON r.id = cp.reserva_id
     JOIN Plataforma p ON p.id = r.plataforma_id
     JOIN Setor s ON s.id = r.setor_id
     WHERE ${whereFinalizados}`
  );
  const finalizados: ChecklistFinalizado[] = finalizadosResult.recordset.map((f) => ({
    plataformaId: f.plataforma_id,
    plataformaNome: f.plataforma_nome,
    categoria: f.categoria,
    setorId: f.setor_id,
    setorNome: f.setor_nome,
    finalizadoEm: f.finalizado_em,
    todosConformes: !!f.todos_conformes,
    inicioEm: f.inicio_em,
  }));

  // 3) Respostas "não conforme" dos checklists finalizados no período (PARTE 22) — usa o
  // texto de snapshot (item_descricao), estável mesmo se a pergunta mudar depois.
  const respostasRequest = pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo);
  let whereRespostas =
    "cr.resultado = 'nao_conforme' AND cp.finalizado_em >= @inicio AND cp.finalizado_em < @fim_exclusivo";
  if (escopoSetorId) {
    respostasRequest.input("setor_id_r", sql.UniqueIdentifier, escopoSetorId);
    whereRespostas += " AND r.setor_id = @setor_id_r";
  }
  whereRespostas += aplicarFiltrosPlataforma(respostasRequest, "p", filtros);
  const respostasResult = await respostasRequest.query<{ item_descricao: string }>(
    `SELECT cr.item_descricao
     FROM ChecklistResposta cr
     JOIN ChecklistPreenchido cp ON cp.id = cr.checklist_preenchido_id
     JOIN Reserva r ON r.id = cp.reserva_id
     JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE ${whereRespostas}`
  );
  const respostasNaoConformes: RespostaNaoConformeResumo[] = respostasResult.recordset.map((r) => ({
    itemDescricao: r.item_descricao,
  }));

  const relacao = calcularRelacaoReservaChecklist(reservasChecklist);

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    ...calcularTaxasChecklist(relacao.reservasQueExigiamChecklist, finalizados),
    tempoMedioConclusaoHoras: calcularTempoMedioConclusaoChecklistHoras(finalizados),
    evolucaoConformidade: calcularEvolucaoConformidade(finalizados),
    naoConformidadePorPlataforma: calcularNaoConformidadePorPlataforma(finalizados),
    itensCriticos: calcularItensChecklistCriticos(respostasNaoConformes),
    porCategoria: calcularChecklistsPorCategoria(finalizados),
    porSetor: calcularChecklistsPorSetor(finalizados),
    relacaoReservaChecklist: relacao,
  };
}

// Substitui buscarChecklistsRelatorio no fluxo ativo (RF-REL-05 renomeado/realinhado).
// Fonte: Comentario.tipo='nao_conformidade' + NaoConformidade (migration 0021) — nunca
// ChecklistPreenchido/Ocorrencia, que ficam congelados como histórico pré-0018.
async function buscarNaoConformidadesRelatorio(
  dateFrom: string,
  dateTo: string,
  escopoSetorId: string | null,
  filtros: FiltrosPlataforma = {}
): Promise<NaoConformidadesRelatorioResposta> {
  const periodo = { dateFrom, dateTo };
  const { inicio, fimExclusivo } = janelaSqlDoPeriodo(periodo);
  const pool = await getPool();

  const dbRequest = pool
    .request()
    .input("inicio", sql.DateTime2, inicio)
    .input("fim_exclusivo", sql.DateTime2, fimExclusivo);
  let where = "c.tipo = 'nao_conformidade' AND c.excluido_em IS NULL AND c.criado_em >= @inicio AND c.criado_em < @fim_exclusivo";
  if (escopoSetorId) {
    dbRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
    where += " AND r.setor_id = @setor_id";
  }
  where += aplicarFiltrosPlataforma(dbRequest, "p", filtros);

  const result = await dbRequest.query<{
    status: "aberta" | "em_analise" | "resolvida";
    setor_id: string;
    setor_nome: string;
    plataforma_id: string;
    plataforma_nome: string;
    criado_em: Date;
    resolvido_em: Date | null;
  }>(
    `SELECT nc.status, r.setor_id, s.nome AS setor_nome, r.plataforma_id, p.nome AS plataforma_nome,
            c.criado_em, nc.resolvido_em
     FROM Comentario c
     JOIN NaoConformidade nc ON nc.comentario_id = c.id
     JOIN Reserva r ON r.id = c.reserva_id
     JOIN Plataforma p ON p.id = r.plataforma_id
     JOIN Setor s ON s.id = r.setor_id
     WHERE ${where}`
  );
  const itens: NaoConformidadeResumo[] = result.recordset.map((linha) => ({
    status: linha.status,
    setorId: linha.setor_id,
    setorNome: linha.setor_nome,
    plataformaId: linha.plataforma_id,
    plataformaNome: linha.plataforma_nome,
    criadoEm: linha.criado_em,
    resolvidoEm: linha.resolvido_em,
  }));

  return {
    periodo: periodoOrigem(dateFrom, dateTo),
    ...calcularKpisNaoConformidades(itens),
    evolucao: calcularEvolucaoNaoConformidades(itens),
    porSetor: calcularNaoConformidadesPorSetor(itens),
    porPlataforma: calcularNaoConformidadesPorPlataforma(itens),
    porStatus: calcularNaoConformidadesPorStatus(itens),
  };
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
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "utilizacao",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId,
        plataforma: filtros.plataforma,
        categoria: filtros.categoria,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarUtilizacao(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId, filtros)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  app.get(
    "/api/v1/relatorios/ranking-setores",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
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
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "sla-aprovacao",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId,
        plataforma: filtros.plataforma,
        categoria: filtros.categoria,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarSlaAprovacao(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId, filtros)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  app.get(
    "/api/v1/relatorios/seguranca",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
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

  // Expansão de Relatórios & Indicadores (Visão Geral + Uso da Frota) — mesmo RBAC de
  // /utilizacao e /sla-aprovacao (Admin global, Gestor de Setor restrito ao próprio setor).
  app.get(
    "/api/v1/relatorios/operacional",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const escopoSetorId = resolverEscopoSetor(request.usuario!, parsed.data.setor);
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "operacional",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId,
        plataforma: filtros.plataforma,
        categoria: filtros.categoria,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarOperacional(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId, filtros)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  // Expansão de Relatórios & Indicadores (Indisponibilidade) — global, mesmo padrão de
  // /ranking-setores e /seguranca (bloqueios não são um dado por setor).
  app.get(
    "/api/v1/relatorios/bloqueios",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "bloqueios",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId: null,
        plataforma: filtros.plataforma,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarBloqueiosRelatorio(parsed.data.dateFrom, parsed.data.dateTo, filtros)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  // Expansão de Relatórios & Indicadores (Segurança & Checklists) — mesmo RBAC/escopo por
  // setor de /utilizacao e /sla-aprovacao (checklist tem setor via Reserva.setor_id).
  app.get(
    "/api/v1/relatorios/checklists",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const escopoSetorId = resolverEscopoSetor(request.usuario!, parsed.data.setor);
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "checklists",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId,
        plataforma: filtros.plataforma,
        categoria: filtros.categoria,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarChecklistsRelatorio(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId, filtros)
      );
      return reply.header("X-Cache", origem === "cache" ? "HIT" : "MISS").status(200).send(valor);
    }
  );

  // Não Conformidades — substitui /checklists no fluxo ativo (mesmo RBAC/escopo por
  // setor). /checklists continua registrada acima por compatibilidade/histórico, mas o
  // frontend não a chama mais.
  app.get(
    "/api/v1/relatorios/nao-conformidades",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const parsed = relatorioQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
      }
      const escopoSetorId = resolverEscopoSetor(request.usuario!, parsed.data.setor);
      const filtros = { plataforma: parsed.data.plataforma, categoria: parsed.data.categoria };
      const chave: ChaveCacheRelatorio = {
        relatorio: "nao-conformidades",
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        escopoSetorId,
        plataforma: filtros.plataforma,
        categoria: filtros.categoria,
      };
      const { valor, origem } = await obterOuCalcularRelatorio(chave, () =>
        buscarNaoConformidadesRelatorio(parsed.data.dateFrom, parsed.data.dateTo, escopoSetorId, filtros)
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
