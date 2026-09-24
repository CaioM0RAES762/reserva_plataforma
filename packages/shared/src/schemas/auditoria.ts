import { z } from "zod";
import { paginacaoQuerySchema } from "./paginacao.js";

export const auditoriaPublicaSchema = z.object({
  id: z.string().uuid(),
  usuarioId: z.string().uuid().nullable(),
  usuarioNome: z.string().nullable(),
  acao: z.string(),
  entidade: z.string(),
  entidadeId: z.string().uuid().nullable(),
  detalhes: z.unknown().nullable(),
  criadoEm: z.string(),
});
export type AuditoriaPublica = z.infer<typeof auditoriaPublicaSchema>;

// RF-AUD-01: filtros por usuário, ação, entidade e período.
export const auditoriaQuerySchema = z.object({
  usuarioId: z.string().uuid().optional(),
  acao: z.string().trim().min(1).optional(),
  entidade: z.string().trim().min(1).optional(),
  // Agrupamentos de apresentação (ver auditoria/categorias.ts). Chegam como texto livre
  // e são validados contra o catálogo antes de virarem WHERE — a rota ignora valor
  // desconhecido em vez de montar um IN() vazio que zeraria a listagem.
  categoria: z.string().trim().min(1).optional(),
  relevancia: z.enum(["informativa", "normal", "importante"]).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida.")
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida.")
    .optional(),
  ...paginacaoQuerySchema.shape,
});
export type AuditoriaQueryInput = z.infer<typeof auditoriaQuerySchema>;
