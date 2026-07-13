import { z } from "zod";

export const GRAVIDADES_OCORRENCIA = ["baixa", "media", "alta"] as const;
export type GravidadeOcorrencia = (typeof GRAVIDADES_OCORRENCIA)[number];

// RF-RES-16/RN-PLAT-04: gravidade + opção explícita de abrir manutenção automática.
export const criarOcorrenciaSchema = z.object({
  descricao: z.string().trim().min(5, "Descreva a ocorrência com pelo menos 5 caracteres.").max(1000),
  gravidade: z.enum(GRAVIDADES_OCORRENCIA),
  geraManutencao: z.boolean().default(false),
});
export type CriarOcorrenciaInput = z.infer<typeof criarOcorrenciaSchema>;

export const ocorrenciaPublicaSchema = z.object({
  id: z.string().uuid(),
  reservaId: z.string().uuid(),
  plataformaId: z.string().uuid(),
  reportadoPorId: z.string().uuid(),
  reportadoPorNome: z.string(),
  descricao: z.string(),
  gravidade: z.enum(GRAVIDADES_OCORRENCIA),
  geraManutencao: z.boolean(),
  criadoEm: z.string(),
});
export type OcorrenciaPublica = z.infer<typeof ocorrenciaPublicaSchema>;
