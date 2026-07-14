import { z } from "zod";

const COR_HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

export const setorPublicoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  corHex: z.string(),
});
export type SetorPublico = z.infer<typeof setorPublicoSchema>;

// RF-SET-01/S12: administração completa de setores (Admin). O status (`ativo`) é
// exposto aqui só na leitura administrativa — GET /setores (legado, S1) continua
// somente leitura e filtrado a ativo=1 para a legenda do Calendário e afins.
export const setorAdminSchema = setorPublicoSchema.extend({
  ativo: z.boolean(),
});
export type SetorAdmin = z.infer<typeof setorAdminSchema>;

export const criarSetorSchema = z.object({
  nome: z.string().trim().min(2, "Nome deve ter no mínimo 2 caracteres.").max(80),
  corHex: z.string().regex(COR_HEX_REGEX, "Informe uma cor hexadecimal válida (ex.: #2563EB)."),
});
export type CriarSetorInput = z.infer<typeof criarSetorSchema>;

export const editarSetorSchema = criarSetorSchema;
export type EditarSetorInput = z.infer<typeof editarSetorSchema>;

// RF-SET-01/RN-USR-02: desativar setor é bloqueado pelo backend se houver usuário
// ativo vinculado — a validação em si vive na rota, não no schema.
export const atualizarStatusSetorSchema = z.object({
  ativo: z.boolean(),
});
export type AtualizarStatusSetorInput = z.infer<typeof atualizarStatusSetorSchema>;
