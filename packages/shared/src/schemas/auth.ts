import { z } from "zod";
import { DOMINIO_EMAIL_PERMITIDO } from "../enums.js";

export const emailMetalsiderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("E-mail inválido")
  .refine((email) => email.endsWith(DOMINIO_EMAIL_PERMITIDO), {
    message: `E-mail deve ser do domínio ${DOMINIO_EMAIL_PERMITIDO}`,
  });

// RN-AUTH-01: minimo 8 caracteres, maiuscula, minuscula e numero
export const senhaSchema = z
  .string()
  .min(8, "A senha deve ter no mínimo 8 caracteres")
  .regex(/[A-Z]/, "A senha deve conter ao menos uma letra maiúscula")
  .regex(/[a-z]/, "A senha deve conter ao menos uma letra minúscula")
  .regex(/[0-9]/, "A senha deve conter ao menos um número");

export const loginSchema = z.object({
  email: emailMetalsiderSchema,
  senha: z.string().min(1, "Senha obrigatória"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const ativarContaSchema = z.object({
  email: emailMetalsiderSchema,
  codigo: z.string().length(6, "Código deve ter 6 dígitos").regex(/^\d{6}$/),
  senha: senhaSchema,
});
export type AtivarContaInput = z.infer<typeof ativarContaSchema>;

export const recuperarSenhaSolicitarSchema = z.object({
  email: emailMetalsiderSchema,
});
export type RecuperarSenhaSolicitarInput = z.infer<typeof recuperarSenhaSolicitarSchema>;

export const recuperarSenhaConfirmarSchema = z.object({
  email: emailMetalsiderSchema,
  codigo: z.string().length(6).regex(/^\d{6}$/),
  novaSenha: senhaSchema,
});
export type RecuperarSenhaConfirmarInput = z.infer<typeof recuperarSenhaConfirmarSchema>;

export const trocarSenhaSchema = z.object({
  senhaAtual: z.string().min(1),
  novaSenha: senhaSchema,
});
export type TrocarSenhaInput = z.infer<typeof trocarSenhaSchema>;
