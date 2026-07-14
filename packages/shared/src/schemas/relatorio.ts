import { z } from "zod";
import { CATEGORIAS_PLATAFORMA } from "../enums.js";

// RF-REL-01..06 (SDD §6.7) — período é obrigatório em toda consulta de relatório
// (evita agregar a base inteira por acidente); `setor` é opcional e só tem efeito para
// o Admin (RN implícita: Gestor de Setor é sempre restrito ao próprio setor no backend,
// mesmo que envie ?setor=<outro> — mesmo padrão de RF-HIST-01/montarWhereHistorico).
export const relatorioQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida."),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida."),
  setor: z.string().uuid().optional(),
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

// RF-REL-06 — exportação de qualquer um dos 4 relatórios em PDF ou Excel.
export const RELATORIOS_EXPORTAVEIS = ["utilizacao", "ranking-setores", "sla-aprovacao", "seguranca"] as const;
export const exportarRelatorioQuerySchema = relatorioQuerySchema.extend({
  relatorio: z.enum(RELATORIOS_EXPORTAVEIS),
  formato: z.enum(["pdf", "excel"]),
});
export type ExportarRelatorioQueryInput = z.infer<typeof exportarRelatorioQuerySchema>;
