import { z } from "zod";

// RF-TV-03: escopo por setor — null/ausente = todos os setores visíveis no painel
// (mesmo padrão de BloqueioAgenda.plataforma_id / PainelToken.setor_id).
export const criarPainelTokenSchema = z.object({
  nome: z.string().trim().min(3, "Nome deve ter no mínimo 3 caracteres.").max(80),
  setorId: z.string().uuid().nullable().optional(),
});
export type CriarPainelTokenInput = z.infer<typeof criarPainelTokenSchema>;

export const painelTokenPublicoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  setorId: z.string().uuid().nullable(),
  setorNome: z.string().nullable(),
  ativo: z.boolean(),
  criadoPorNome: z.string(),
  criadoEm: z.string(),
  ultimoUsoEm: z.string().nullable(),
});
export type PainelTokenPublico = z.infer<typeof painelTokenPublicoSchema>;

// Retornado apenas na criação — única vez em que o token em texto puro é exposto.
export const painelTokenCriadoSchema = painelTokenPublicoSchema.extend({
  token: z.string(),
});
export type PainelTokenCriado = z.infer<typeof painelTokenCriadoSchema>;

export const painelReservaSchema = z.object({
  id: z.string().uuid(),
  plataformaNome: z.string(),
  setorNome: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
  status: z.string(),
});

export const painelPlataformaSchema = z.object({
  id: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  status: z.string(),
});

export const painelDadosSchema = z.object({
  atualizadoEm: z.string(),
  reservasHoje: z.array(painelReservaSchema),
  proximasDuasHoras: z.array(painelReservaSchema),
  plataformas: z.array(painelPlataformaSchema),
});
export type PainelDados = z.infer<typeof painelDadosSchema>;
