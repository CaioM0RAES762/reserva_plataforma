import { z } from "zod";
import { STATUS_NAO_CONFORMIDADE } from "../enums.js";
import { paginacaoQuerySchema } from "./paginacao.js";

/* Área "Não Conformidades" (sidebar, sob OPERAÇÃO).
 *
 * A origem do dado continua sendo o comentário marcado como não conformidade
 * (Comentario.tipo='nao_conformidade') — esta rota só agrega essas entradas entre
 * reservas, com o status de tratamento (NaoConformidade, migration 0021). Nenhum dado é
 * duplicado: descrição/imagens/reserva continuam vivendo em Comentario/ComentarioImagem.
 */

export const naoConformidadeFiltroQuerySchema = paginacaoQuerySchema.extend({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida.").optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida.").optional(),
  setor: z.string().uuid().optional(),
  plataforma: z.string().uuid().optional(),
  responsavel: z.string().uuid().optional(),
  status: z.enum(STATUS_NAO_CONFORMIDADE).optional(),
  texto: z.string().trim().max(200).optional(),
});
export type NaoConformidadeFiltroQuery = z.infer<typeof naoConformidadeFiltroQuerySchema>;

export const atualizarStatusNaoConformidadeSchema = z.object({
  status: z.enum(STATUS_NAO_CONFORMIDADE),
});
export type AtualizarStatusNaoConformidadeInput = z.infer<typeof atualizarStatusNaoConformidadeSchema>;

const imagemNaoConformidadeSchema = z.object({
  id: z.string().uuid(),
  nomeArquivo: z.string(),
  tipoMime: z.string(),
  url: z.string(),
});

export const naoConformidadePublicaSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(STATUS_NAO_CONFORMIDADE),
  criadoEm: z.string(),
  resolvidoEm: z.string().nullable(),
  descricao: z.string(),
  imagens: z.array(imagemNaoConformidadeSchema),
  autorId: z.string().uuid(),
  autorNome: z.string(),
  reservaId: z.string().uuid(),
  setorId: z.string().uuid(),
  setorNome: z.string(),
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
});
export type NaoConformidadePublica = z.infer<typeof naoConformidadePublicaSchema>;
