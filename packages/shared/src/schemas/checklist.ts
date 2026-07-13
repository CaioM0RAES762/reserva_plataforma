import { z } from "zod";
import { CATEGORIAS_PLATAFORMA } from "../enums.js";

// S8 — SDD §4.3/§6.5/§7 (RF-CHK-*/RN-CHK-*). Templates de checklist só existem para as
// categorias que podem exigi-lo — sala/pátio nunca têm checklist (SDD §2.4).
export const CATEGORIAS_COM_TEMPLATE_CHECKLIST = ["elevatoria", "andaime", "veiculo", "outro"] as const;

export const checklistItemTemplateSchema = z.object({
  id: z.string().uuid(),
  categoriaPlataforma: z.enum(CATEGORIAS_COM_TEMPLATE_CHECKLIST),
  descricao: z.string(),
  ordem: z.number().int(),
  obrigatorio: z.boolean(),
  ativo: z.boolean(),
});
export type ChecklistItemTemplate = z.infer<typeof checklistItemTemplateSchema>;

export const criarChecklistItemTemplateSchema = z.object({
  categoriaPlataforma: z.enum(CATEGORIAS_COM_TEMPLATE_CHECKLIST),
  descricao: z.string().trim().min(3, "Descrição deve ter no mínimo 3 caracteres.").max(300),
  ordem: z.number().int().nonnegative(),
  obrigatorio: z.boolean().default(true),
});
export type CriarChecklistItemTemplateInput = z.infer<typeof criarChecklistItemTemplateSchema>;

// RN-CHK-01: observacao obrigatória quando conforme = false — reforçado no backend
// (checklist.service.ts) porque depende do valor de outro campo do mesmo objeto.
export const checklistRespostaInputSchema = z.object({
  itemId: z.string().uuid(),
  conforme: z.boolean(),
  observacao: z.string().trim().max(300).optional(),
  // Evidência fotográfica opcional (RF-CHK-04) — data URL (base64), armazenamento
  // simplificado nesta sprint via storage.service.ts (ver ADR no relatório S8).
  fotoBase64: z.string().optional(),
});
export type ChecklistRespostaInput = z.infer<typeof checklistRespostaInputSchema>;

export const preencherChecklistSchema = z.object({
  respostas: z.array(checklistRespostaInputSchema).min(1, "Informe ao menos uma resposta."),
});
export type PreencherChecklistInput = z.infer<typeof preencherChecklistSchema>;

export const checklistRespostaPublicaSchema = z.object({
  itemId: z.string().uuid(),
  descricao: z.string(),
  ordem: z.number().int(),
  obrigatorio: z.boolean(),
  conforme: z.boolean().nullable(),
  observacao: z.string().nullable(),
  fotoUrl: z.string().nullable(),
});
export type ChecklistRespostaPublica = z.infer<typeof checklistRespostaPublicaSchema>;

export const checklistReservaSchema = z.object({
  requerChecklist: z.boolean(),
  todosConformes: z.boolean().nullable(),
  preenchidoPorNome: z.string().nullable(),
  preenchidoEm: z.string().nullable(),
  itens: z.array(checklistRespostaPublicaSchema),
});
export type ChecklistReserva = z.infer<typeof checklistReservaSchema>;
