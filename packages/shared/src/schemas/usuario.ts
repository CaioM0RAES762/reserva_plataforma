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

// RF-USR-05 (S7 — mecanismo provisório; UI completa só em S12). RN-USR-01: gestor_setor
// e colaborador exigem setorId; admin não tem setor.
export const atualizarPerfilUsuarioSchema = z
  .object({
    perfil: z.enum(PERFIS),
    setorId: z.string().uuid().nullable().optional(),
  })
  .refine((dados) => dados.perfil === "admin" || !!dados.setorId, {
    message: "setorId é obrigatório para os perfis gestor_setor e colaborador.",
    path: ["setorId"],
  });
export type AtualizarPerfilUsuarioInput = z.infer<typeof atualizarPerfilUsuarioSchema>;
