import { z } from "zod";

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
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida.")
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida.")
    .optional(),
});
export type AuditoriaQueryInput = z.infer<typeof auditoriaQuerySchema>;
