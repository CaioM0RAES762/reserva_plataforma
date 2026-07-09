import { z } from "zod";
import { PERFIS } from "../enums.js";
import { emailMetalsiderSchema } from "./auth.js";

export const usuarioPublicoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  email: z.string(),
  perfil: z.enum(PERFIS),
  setorId: z.string().uuid().nullable(),
  ativo: z.boolean(),
  emailVerificado: z.boolean(),
});
export type UsuarioPublico = z.infer<typeof usuarioPublicoSchema>;

export const criarUsuarioSchema = z.object({
  nome: z.string().min(2).max(120),
  email: emailMetalsiderSchema,
  perfil: z.enum(PERFIS),
  setorId: z.string().uuid().nullable().optional(),
});
export type CriarUsuarioInput = z.infer<typeof criarUsuarioSchema>;
