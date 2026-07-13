import { z } from "zod";

export const criarComentarioSchema = z.object({
  mensagem: z.string().trim().min(1, "O comentário não pode ser vazio.").max(1000),
});
export type CriarComentarioInput = z.infer<typeof criarComentarioSchema>;

export const comentarioPublicoSchema = z.object({
  id: z.string().uuid(),
  reservaId: z.string().uuid(),
  usuarioId: z.string().uuid(),
  usuarioNome: z.string(),
  mensagem: z.string(),
  criadoEm: z.string(),
});
export type ComentarioPublico = z.infer<typeof comentarioPublicoSchema>;
