import { z } from "zod";
import { STATUS_PLATAFORMA } from "../enums.js";

export const plataformaPublicaSchema = z.object({
  id: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  localizacao: z.string().nullable(),
  capacidade: z.number().int().nullable(),
  status: z.enum(STATUS_PLATAFORMA),
  observacoes: z.string().nullable(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});
export type PlataformaPublica = z.infer<typeof plataformaPublicaSchema>;

export const criarPlataformaSchema = z.object({
  codigo: z.string().trim().min(2, "Código deve ter no mínimo 2 caracteres").max(30),
  nome: z.string().trim().min(2, "Nome deve ter no mínimo 2 caracteres").max(120),
  localizacao: z.string().trim().max(160).optional(),
  capacidade: z.number().int().positive().optional(),
  observacoes: z.string().trim().max(500).optional(),
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
});
export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;
