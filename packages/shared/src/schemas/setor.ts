import { z } from "zod";

export const setorPublicoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  corHex: z.string(),
});
export type SetorPublico = z.infer<typeof setorPublicoSchema>;
