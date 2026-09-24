import { z } from "zod";
import { CATEGORIAS_PLATAFORMA, STATUS_NAO_CONFORMIDADE } from "../enums.js";

// RF-REL-01..06 (SDD §6.7) — período é obrigatório em toda consulta de relatório
// (evita agregar a base inteira por acidente); `setor` é opcional e só tem efeito para
// o Admin (RN implícita: Gestor de Setor é sempre restrito ao próprio setor no backend,
// mesmo que envie ?setor=<outro> — mesmo padrão de RF-HIST-01/montarWhereHistorico).
// `plataforma`/`categoria` (expansão da área de Relatórios) são filtros globais
// adicionais, aplicados igualmente a todos os endpoints que fizer sentido.
export const relatorioQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida."),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida."),
  setor: z.string().uuid().optional(),
  plataforma: z.string().uuid().optional(),
  categoria: z.enum(CATEGORIAS_PLATAFORMA).optional(),
});
export type RelatorioQueryInput = z.infer<typeof relatorioQuerySchema>;

const periodoSchema = z.object({
  inicio: z.string(),
  fim: z.string(),
});

// RF-REL-01 — % do tempo em reservas agendada/em_uso/concluida sobre o tempo total
// disponível no período (descontando bloqueios de agenda de S9), por plataforma.
export const utilizacaoPlataformaSchema = z.object({
  plataformaId: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  categoria: z.enum(CATEGORIAS_PLATAFORMA),
  horasDisponiveis: z.number(),
  horasReservadas: z.number(),
  taxaUtilizacao: z.number(),
});
export const utilizacaoRespostaSchema = z.object({
  periodo: periodoSchema,
  plataformas: z.array(utilizacaoPlataformaSchema),
});
export type UtilizacaoResposta = z.infer<typeof utilizacaoRespostaSchema>;

// RF-REL-02 — ranking de setores por volume de reservas e taxa de rejeição. Admin only
// (visão entre setores, SDD §2.3 — Gestor de Setor "não pode visualizar dados de outros
// setores").
export const rankingSetorItemSchema = z.object({
  setorId: z.string().uuid(),
  setorNome: z.string(),
  corHex: z.string(),
  totalReservas: z.number(),
  totalRejeitadas: z.number(),
  taxaRejeicao: z.number(),
});
export const rankingSetoresRespostaSchema = z.object({
  periodo: periodoSchema,
  setores: z.array(rankingSetorItemSchema),
});
export type RankingSetoresResposta = z.infer<typeof rankingSetoresRespostaSchema>;

const distribuicaoItemSchema = z.object({
  chave: z.string(),
  quantidade: z.number(),
});
const tendenciaMensalItemSchema = z.object({
  mes: z.string(),
  quantidade: z.number(),
});

// RF-REL-03 — tempo médio de aprovação (criação → decisão final, em horas) e distribuição
// por status; RF-REL-04 — tendência mensal e distribuição por prioridade/categoria.
// Agrupados na mesma rota (/sla-aprovacao): ambos derivam do mesmo conjunto de reservas
// do período, sem necessidade de uma 5ª rota fora das 4 previstas na API REST do SDD §11.
export const slaAprovacaoRespostaSchema = z.object({
  periodo: periodoSchema,
  tempoMedioAprovacaoHoras: z.number().nullable(),
  totalDecisoes: z.number(),
  // PARTE 27/28 — aprovação/rejeição são derivadas da ÚLTIMA ação de LogAuditoria para
  // cada reserva decidida (mesma fonte de `tempoMedioAprovacaoHoras`), não do status atual
  // da reserva (que pode já ter avançado para em_uso/concluida).
  totalAprovadas: z.number(),
  totalRejeitadas: z.number(),
  taxaAprovacao: z.number(),
  taxaRejeicao: z.number(),
  pendentesAtuais: z.number(),
  porStatus: z.array(distribuicaoItemSchema),
  porPrioridade: z.array(distribuicaoItemSchema),
  porCategoria: z.array(distribuicaoItemSchema),
  tendenciaMensal: z.array(tendenciaMensalItemSchema),
});
export type SlaAprovacaoResposta = z.infer<typeof slaAprovacaoRespostaSchema>;

// RF-REL-05 — % de checklists com ao menos um item não conforme; ocorrências por
// plataforma e por gravidade. Admin only (indicador de segurança entre setores).
export const segurancaOcorrenciaPlataformaSchema = z.object({
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  baixa: z.number(),
  media: z.number(),
  alta: z.number(),
  total: z.number(),
});
export const segurancaRespostaSchema = z.object({
  periodo: periodoSchema,
  totalChecklists: z.number(),
  totalChecklistsNaoConformes: z.number(),
  percentualChecklistNaoConforme: z.number(),
  ocorrenciasPorPlataforma: z.array(segurancaOcorrenciaPlataformaSchema),
});
export type SegurancaResposta = z.infer<typeof segurancaRespostaSchema>;

// RF-REL-06 — exportação de qualquer um dos 4 relatórios em PDF ou Excel. Os 3 relatórios
// novos abaixo (operacional/bloqueios/checklists) não entram nesta exportação nesta
// rodada — corte de escopo documentado no relatório técnico final.
export const RELATORIOS_EXPORTAVEIS = ["utilizacao", "ranking-setores", "sla-aprovacao", "seguranca"] as const;
export const exportarRelatorioQuerySchema = relatorioQuerySchema.extend({
  relatorio: z.enum(RELATORIOS_EXPORTAVEIS),
  formato: z.enum(["pdf", "excel"]),
});
export type ExportarRelatorioQueryInput = z.infer<typeof exportarRelatorioQuerySchema>;

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/operacional
// (Visão Geral + Uso da Frota: totais do período, evolução diária, horários de maior
// demanda, ranking de plataformas mais reservadas)
// ---------------------------------------------------------------------------

export const evolucaoDiariaItemSchema = z.object({
  data: z.string(), // YYYY-MM-DD
  quantidadeReservas: z.number(),
  horasReservadas: z.number(),
});
export const demandaPorHoraItemSchema = z.object({
  hora: z.number(), // 0-23, hora civil de início do intervalo
  quantidade: z.number(),
});
export const rankingPlataformaItemSchema = z.object({
  plataformaId: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  totalReservas: z.number(),
  horasReservadas: z.number(),
});
export const operacionalRespostaSchema = z.object({
  periodo: periodoSchema,
  totalReservas: z.number(),
  horasReservadasTotais: z.number(),
  totalCanceladas: z.number(),
  taxaCancelamento: z.number(),
  evolucaoDiaria: z.array(evolucaoDiariaItemSchema),
  demandaPorHora: z.array(demandaPorHoraItemSchema),
  rankingPlataformas: z.array(rankingPlataformaItemSchema),
});
export type OperacionalResposta = z.infer<typeof operacionalRespostaSchema>;

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/bloqueios (Indisponibilidade)
// ---------------------------------------------------------------------------

export const motivoBloqueioItemSchema = z.object({
  motivo: z.string(),
  horasBloqueadas: z.number(),
  ocorrencias: z.number(),
});
export const tendenciaBloqueioItemSchema = z.object({
  data: z.string(), // YYYY-MM-DD
  horasBloqueadas: z.number(),
});
export const bloqueiosRelatorioRespostaSchema = z.object({
  periodo: periodoSchema,
  horasBloqueadasTotais: z.number(),
  totalBloqueios: z.number(),
  // Ranking pelos valores literais de `motivo` (texto livre — não existe um campo "tipo"
  // de bloqueio no schema atual, então motivos com texto ligeiramente diferente aparecem
  // como entradas separadas).
  porMotivo: z.array(motivoBloqueioItemSchema),
  tendencia: z.array(tendenciaBloqueioItemSchema),
});
export type BloqueiosRelatorioResposta = z.infer<typeof bloqueiosRelatorioRespostaSchema>;

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — GET /relatorios/checklists
// (Segurança & Checklists)
// ---------------------------------------------------------------------------

export const conformidadeSemanalItemSchema = z.object({
  semanaInicio: z.string(), // YYYY-MM-DD, segunda-feira da semana
  taxaConformidade: z.number(),
  totalFinalizados: z.number(),
});
export const naoConformidadePorPlataformaItemSchema = z.object({
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  naoConformidades: z.number(),
});
export const itemChecklistCriticoSchema = z.object({
  itemDescricao: z.string(),
  ocorrencias: z.number(),
});
export const checklistPorCategoriaItemSchema = z.object({
  categoria: z.enum(CATEGORIAS_PLATAFORMA),
  totalRealizados: z.number(),
  totalConformes: z.number(),
  totalNaoConformes: z.number(),
});
export const checklistPorSetorItemSchema = z.object({
  setorId: z.string().uuid(),
  setorNome: z.string(),
  totalRealizados: z.number(),
  totalConformes: z.number(),
  totalNaoConformes: z.number(),
});
export const relacaoReservaChecklistSchema = z.object({
  reservasQueExigiamChecklist: z.number(),
  reservasComChecklistRealizado: z.number(),
  reservasIniciadasAposChecklist: z.number(),
});
export const checklistsRelatorioRespostaSchema = z.object({
  periodo: periodoSchema,
  totalExigidos: z.number(),
  totalConcluidos: z.number(),
  taxaConclusao: z.number(),
  totalConformes: z.number(),
  totalNaoConformes: z.number(),
  taxaConformidade: z.number(),
  tempoMedioConclusaoHoras: z.number().nullable(),
  evolucaoConformidade: z.array(conformidadeSemanalItemSchema),
  naoConformidadePorPlataforma: z.array(naoConformidadePorPlataformaItemSchema),
  itensCriticos: z.array(itemChecklistCriticoSchema),
  porCategoria: z.array(checklistPorCategoriaItemSchema),
  porSetor: z.array(checklistPorSetorItemSchema),
  relacaoReservaChecklist: relacaoReservaChecklistSchema,
});
export type ChecklistsRelatorioResposta = z.infer<typeof checklistsRelatorioRespostaSchema>;

// ---------------------------------------------------------------------------
// GET /relatorios/nao-conformidades — substitui a aba "Segurança & Checklists".
// Fonte: Comentario.tipo='nao_conformidade' + NaoConformidade (migration 0021), não
// checklist. taxaResolucao é `null` (não `0`) quando total=0 — matematicamente não
// aplicável, a UI mostra "—".
// ---------------------------------------------------------------------------

export const naoConformidadeSemanalItemSchema = z.object({
  semanaInicio: z.string(), // YYYY-MM-DD, segunda-feira da semana
  total: z.number(),
});
export const naoConformidadePorSetorItemSchema = z.object({
  setorId: z.string().uuid(),
  setorNome: z.string(),
  total: z.number(),
});
export const naoConformidadePorPlataformaItemSchema2 = z.object({
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  total: z.number(),
});
export const naoConformidadePorStatusItemSchema = z.object({
  status: z.enum(STATUS_NAO_CONFORMIDADE),
  total: z.number(),
});
export const naoConformidadesRelatorioRespostaSchema = z.object({
  periodo: periodoSchema,
  total: z.number(),
  abertas: z.number(),
  emAnalise: z.number(),
  resolvidas: z.number(),
  taxaResolucao: z.number().nullable(),
  evolucao: z.array(naoConformidadeSemanalItemSchema),
  porSetor: z.array(naoConformidadePorSetorItemSchema),
  porPlataforma: z.array(naoConformidadePorPlataformaItemSchema2),
  porStatus: z.array(naoConformidadePorStatusItemSchema),
});
export type NaoConformidadesRelatorioResposta = z.infer<typeof naoConformidadesRelatorioRespostaSchema>;
