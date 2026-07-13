import { z } from "zod";

const DATA_URL_REGEX = /^data:[\w.+-]+\/[\w.+-]+;base64,.+$/;

// RF-RES-14: upload trafega como data URL base64 (mesmo padrão de S8 para fotos de
// checklist) — o mime real é sempre verificado no backend via magic bytes (SDD §12),
// nunca confiando no prefixo declarado aqui.
export const criarAnexoSchema = z.object({
  nomeArquivo: z.string().trim().min(1, "Informe o nome do arquivo.").max(200),
  arquivoBase64: z.string().regex(DATA_URL_REGEX, "Formato inválido — esperado data URL base64."),
});
export type CriarAnexoInput = z.infer<typeof criarAnexoSchema>;

export const anexoPublicoSchema = z.object({
  id: z.string().uuid(),
  reservaId: z.string().uuid(),
  nomeArquivo: z.string(),
  tipoMime: z.string(),
  tamanhoBytes: z.number().int(),
  enviadoPorId: z.string().uuid(),
  enviadoPorNome: z.string(),
  // SAS de leitura, curta duração (RNF-09) — gerado sob demanda, nunca persistido.
  url: z.string(),
  criadoEm: z.string(),
});
export type AnexoPublico = z.infer<typeof anexoPublicoSchema>;
