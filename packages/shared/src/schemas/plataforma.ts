import { z } from "zod";
import { CATEGORIAS_PLATAFORMA, RISCOS_PLATAFORMA, STATUS_PLATAFORMA } from "../enums.js";

// Mesmo formato de S11 (Anexo/checklist) — data URL base64, mime real verificado no
// backend por magic bytes (SDD §12), nunca confiando no prefixo declarado aqui.
const DATA_URL_REGEX = /^data:[\w.+-]+\/[\w.+-]+;base64,.+$/;

export const eventoAtivoPlataformaSchema = z.object({
  texto: z.string(),
  detalhe: z.string().nullable(),
});
export type EventoAtivoPlataforma = z.infer<typeof eventoAtivoPlataformaSchema>;

export const plataformaPublicaSchema = z.object({
  id: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  localizacao: z.string().nullable(),
  capacidade: z.number().int().nullable(),
  status: z.enum(STATUS_PLATAFORMA),
  categoria: z.enum(CATEGORIAS_PLATAFORMA),
  risco: z.enum(RISCOS_PLATAFORMA),
  aprovacaoAutomatica: z.boolean(),
  observacoes: z.string().nullable(),
  // SAS de leitura, curta duração (RNF-09) — gerado sob demanda, nunca persistido.
  imagemUrl: z.string().nullable(),
  tipoEquipamento: z.string().nullable(),
  alturaMaximaM: z.number().nullable(),
  capacidadeOperadores: z.number().int().nullable(),
  // Atualizado manualmente pelo Admin — não há sensor/telemetria nesta versão.
  horimetroHoras: z.number().int().nullable(),
  // % de horas reservadas nos últimos 30 dias — calculado em tempo de leitura a partir
  // de Reserva, nunca persistido.
  utilizacao30d: z.number().int().nullable(),
  // Ocorrência aberta / reserva em uso / próxima reserva, o que for mais relevante agora.
  evento: eventoAtivoPlataformaSchema.nullable(),
  // NR-18/NR-35 — derivados de categoria/altura máxima, não é um campo cadastrado à parte.
  normas: z.array(z.string()),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});
export type PlataformaPublica = z.infer<typeof plataformaPublicaSchema>;

export const criarPlataformaSchema = z.object({
  codigo: z.string().trim().min(2, "Código deve ter no mínimo 2 caracteres").max(30),
  nome: z.string().trim().min(2, "Nome deve ter no mínimo 2 caracteres").max(120),
  localizacao: z.string().trim().max(160).optional(),
  capacidade: z.number().int().positive().optional(),
  categoria: z.enum(CATEGORIAS_PLATAFORMA).default("outro"),
  // RN: risco tem default por categoria (SDD §2.4) — quando omitido, o backend aplica
  // RISCO_PADRAO_POR_CATEGORIA; quando informado, o Admin pode sobrescrever.
  risco: z.enum(RISCOS_PLATAFORMA).optional(),
  aprovacaoAutomatica: z.boolean().default(false),
  observacoes: z.string().trim().max(500).optional(),
  tipoEquipamento: z.string().trim().max(80).optional(),
  alturaMaximaM: z.number().positive().max(999).optional(),
  capacidadeOperadores: z.number().int().positive().max(50).optional(),
  horimetroHoras: z.number().int().nonnegative().optional(),
  // Imagem opcional do equipamento — sem imagem, o card exibe placeholder.
  imagemBase64: z.string().regex(DATA_URL_REGEX, "Formato inválido — esperado data URL base64.").optional(),
  // Só relevante na edição: remove a imagem atual quando nenhuma nova é enviada.
  removerImagem: z.boolean().optional(),
});
export type CriarPlataformaInput = z.infer<typeof criarPlataformaSchema>;

export const editarPlataformaSchema = criarPlataformaSchema;
export type EditarPlataformaInput = z.infer<typeof editarPlataformaSchema>;

// RN-PLAT-03: "reservada" é sempre derivado (nunca definido manualmente) — excluído das opções aqui.
const STATUS_EDITAVEIS_MANUALMENTE = ["disponivel", "manutencao", "inativa"] as const;
export const atualizarStatusPlataformaSchema = z.object({
  status: z.enum(STATUS_EDITAVEIS_MANUALMENTE),
});
export type AtualizarStatusPlataformaInput = z.infer<typeof atualizarStatusPlataformaSchema>;

export const dashboardKpisSchema = z.object({
  totalPlataformas: z.number().int().nonnegative(),
  disponiveis: z.number().int().nonnegative(),
  pendenciasAprovacao: z.number().int().nonnegative(),
});
export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;
