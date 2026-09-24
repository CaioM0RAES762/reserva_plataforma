import { z } from "zod";
import { PERFIS } from "../enums.js";
import { emailMetalsiderSchema } from "./auth.js";
import { MENSAGEM_TELEFONE_INVALIDO, TELEFONE_TAMANHO_MAXIMO, telefoneValido } from "../telefone.js";

export const usuarioPublicoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  email: z.string(),
  telefone: z.string().nullable(),
  perfil: z.enum(PERFIS),
  setorId: z.string().uuid().nullable(),
  ativo: z.boolean(),
  emailVerificado: z.boolean(),
});
export type UsuarioPublico = z.infer<typeof usuarioPublicoSchema>;

// Telefone obrigatório na criação (mesmo padrão de Reserva.telefoneContato) — usuários
// existentes antes desta coluna ficam com NULL (não retroativo, ver migration 0021), mas
// todo cadastro/criação novo exige o dado.
export const criarUsuarioSchema = z.object({
  nome: z.string().min(2).max(120),
  email: emailMetalsiderSchema,
  telefone: z.string().trim().max(TELEFONE_TAMANHO_MAXIMO).refine(telefoneValido, MENSAGEM_TELEFONE_INVALIDO),
  perfil: z.enum(PERFIS),
  setorId: z.string().uuid().nullable().optional(),
});
export type CriarUsuarioInput = z.infer<typeof criarUsuarioSchema>;

// RF-USR-05 (S7 — mecanismo provisório; UI completa em S12). RN-USR-01: gestor_setor
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

// RF-USR-01/S12: edição de dados cadastrais (nome/e-mail/telefone/setor) — perfil é
// alterado separadamente via atualizarPerfilUsuarioSchema (RF-USR-05, já existente desde
// S7). Telefone opcional aqui (diferente da criação): usuários anteriores à migration 0021
// não têm o dado, e editar nome/e-mail não deveria travar por causa de um campo que a conta
// nunca teve — mesmo padrão de Plataforma.telefoneEmergencia (opcional, "" aceito).
export const editarUsuarioSchema = z.object({
  nome: z.string().min(2).max(120),
  email: emailMetalsiderSchema,
  telefone: z
    .string()
    .trim()
    .max(TELEFONE_TAMANHO_MAXIMO)
    .refine((valor) => valor === "" || telefoneValido(valor), MENSAGEM_TELEFONE_INVALIDO)
    .optional(),
  setorId: z.string().uuid().nullable().optional(),
});
export type EditarUsuarioInput = z.infer<typeof editarUsuarioSchema>;

// RF-USR-03: ativar/desativar usuário (soft delete — preserva histórico de reservas).
export const atualizarStatusUsuarioSchema = z.object({
  ativo: z.boolean(),
});
export type AtualizarStatusUsuarioInput = z.infer<typeof atualizarStatusUsuarioSchema>;
