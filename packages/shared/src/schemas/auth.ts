import { z } from "zod";
import { DOMINIO_EMAIL_PERMITIDO } from "../enums.js";
import { MENSAGEM_TELEFONE_INVALIDO, TELEFONE_TAMANHO_MAXIMO, telefoneValido } from "../telefone.js";

export const emailMetalsiderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("E-mail inválido")
  .refine((email) => email.endsWith(DOMINIO_EMAIL_PERMITIDO), {
    message: `E-mail deve ser do domínio ${DOMINIO_EMAIL_PERMITIDO}`,
  });

// RN-AUTH-01: minimo 8 caracteres, minuscula e numero
export const senhaSchema = z
  .string()
  .min(8, "A senha deve ter no mínimo 8 caracteres")
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

// Reenvio para uma conta que já existe (nascida por autocadastro ou criada pelo Admin).
// `nome`/`setorId` continuam opcionais aqui: servem só para registrar divergência em
// auditoria (ver comentário em auth.ts), nunca para bloquear o reenvio — um erro de
// digitação no nome não pode impedir alguém de reenviar o próprio código.
export const ativarContaReenviarSchema = z.object({
  email: emailMetalsiderSchema,
  nome: z.string().trim().min(1).max(120).optional(),
  setorId: z.string().uuid().optional(),
});
export type AtivarContaReenviarInput = z.infer<typeof ativarContaReenviarSchema>;

// Autocadastro (RN-USR-01 estendida): qualquer e-mail do domínio corporativo pode se
// cadastrar sozinho — o perfil nasce sempre "colaborador" (nunca escolhido pelo usuário) e
// setorId é obrigatório, igual à regra que já vale para colaborador/gestor_setor na criação
// pelo Admin. O Admin deixa de ser o único jeito de uma conta nascer; seu papel passa a ser
// só promover/rebaixar perfil e ativar/desativar contas.
export const cadastrarContaSchema = z.object({
  nome: z.string().trim().min(2, "Nome deve ter ao menos 2 caracteres").max(120),
  email: emailMetalsiderSchema,
  // Obrigatório (RF-USR): mesmo padrão de validação de Reserva.telefoneContato — permite
  // preencher automaticamente o contato da reserva a partir do perfil do usuário.
  telefone: z.string().trim().max(TELEFONE_TAMANHO_MAXIMO).refine(telefoneValido, MENSAGEM_TELEFONE_INVALIDO),
  setorId: z.string().uuid("Selecione um setor"),
});
export type CadastrarContaInput = z.infer<typeof cadastrarContaSchema>;

export const recuperarSenhaConfirmarSchema = z.object({
  email: emailMetalsiderSchema,
  codigo: z.string().length(6).regex(/^\d{6}$/),
  novaSenha: senhaSchema,
});
export type RecuperarSenhaConfirmarInput = z.infer<typeof recuperarSenhaConfirmarSchema>;

export const trocarSenhaPayloadSchema = z.object({
  senhaAtual: z.string().min(1, "Senha atual obrigatória"),
  novaSenha: z.string().min(1, "Nova senha obrigatória"),
});

// Schema completo para consumidores que validam a troca de uma vez. A rota usa primeiro
// `trocarSenhaPayloadSchema` para poder autenticar a senha atual e priorizar a mensagem de
// igualdade; em seguida aplica `senhaSchema`, a mesma fonte de verdade de complexidade.
export const trocarSenhaSchema = trocarSenhaPayloadSchema.extend({
  novaSenha: senhaSchema,
});
export type TrocarSenhaInput = z.infer<typeof trocarSenhaSchema>;
