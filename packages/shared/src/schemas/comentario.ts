import { z } from "zod";

/* Comentários da reserva — a timeline operacional.
 *
 * Substituem a antiga separação "Anexos | Comentários": a imagem passa a pertencer ao
 * comentário que a explica, em vez de existir como arquivo solto sem contexto.
 *
 * O tipo é um enum semântico numa coluna, não um punhado de booleanos: um comentário É de
 * um tipo, e "não conformidade" é uma classificação do próprio registro — não uma
 * entidade paralela. Isso também é o que consolida o antigo fluxo de "Ocorrência" num
 * ponto único de registro operacional.
 */
export const TIPOS_COMENTARIO = ["comentario", "nao_conformidade"] as const;
export type TipoComentario = (typeof TIPOS_COMENTARIO)[number];

/** Formatos aceitos no composer. Verificados por magic bytes no backend, nunca por extensão. */
export const MIMES_IMAGEM_COMENTARIO = ["image/jpeg", "image/png", "image/webp"] as const;

export const MAX_IMAGENS_POR_COMENTARIO = 4;

const DATA_URL_REGEX = /^data:[\w.+-]+\/[\w.+-]+;base64,.+$/;

export const imagemComentarioInputSchema = z.object({
  nomeArquivo: z.string().trim().min(1, "Informe o nome do arquivo.").max(200),
  // Mesmo transporte já usado por anexos e fotos de checklist: data URL base64. O mime
  // declarado aqui é apenas uma dica — o backend confere os bytes reais.
  arquivoBase64: z.string().regex(DATA_URL_REGEX, "Formato inválido — esperado data URL base64."),
});
export type ImagemComentarioInput = z.infer<typeof imagemComentarioInputSchema>;

export const criarComentarioSchema = z
  .object({
    mensagem: z.string().trim().max(1000).default(""),
    tipo: z.enum(TIPOS_COMENTARIO).default("comentario"),
    imagens: z.array(imagemComentarioInputSchema).max(MAX_IMAGENS_POR_COMENTARIO).default([]),
  })
  // Um comentário comum pode ser só uma foto ("cheguei, está assim"); uma não conformidade
  // não pode — a foto mostra, mas não diz o que está errado nem o que se espera. Registro
  // de NC sem texto é inútil para quem for tratá-la depois.
  .refine((dados) => dados.tipo !== "nao_conformidade" || dados.mensagem.trim().length >= 3, {
    message: "Descreva a não conformidade antes de registrar.",
    path: ["mensagem"],
  })
  .refine((dados) => dados.mensagem.trim().length > 0 || dados.imagens.length > 0, {
    message: "Escreva um comentário ou adicione uma imagem.",
    path: ["mensagem"],
  });
export type CriarComentarioInput = z.infer<typeof criarComentarioSchema>;

/* Edição: mensagem é sempre reenviada por inteiro (o composer reabre preenchido — não é um
 * PATCH parcial de texto), e imagens são tratadas como duas listas (remover/adicionar) em vez
 * de um array substituindo o total — evita reenviar em base64 imagens que não mudaram.
 *
 * `tipo` é IMUTÁVEL depois de criado: não há pedido para permitir alternar entre comentário e
 * não conformidade, e mudar isso retroativamente teria efeito colateral em auditoria/
 * notificação já disparadas para o tipo original.
 *
 * A validação final (texto OU imagem restante; não conformidade exige texto) depende da
 * contagem de imagens já existentes, que só a rota conhece — por isso é feita ali, não aqui. */
export const atualizarComentarioSchema = z.object({
  mensagem: z.string().trim().max(1000).default(""),
  imagensRemover: z.array(z.string().uuid()).max(MAX_IMAGENS_POR_COMENTARIO).default([]),
  imagensAdicionar: z.array(imagemComentarioInputSchema).max(MAX_IMAGENS_POR_COMENTARIO).default([]),
});
export type AtualizarComentarioInput = z.infer<typeof atualizarComentarioSchema>;

export const imagemComentarioPublicaSchema = z.object({
  id: z.string().uuid(),
  nomeArquivo: z.string(),
  tipoMime: z.string(),
  /** URL de leitura assinada, curta duração (RNF-09) — gerada sob demanda, nunca persistida. */
  url: z.string(),
});
export type ImagemComentarioPublica = z.infer<typeof imagemComentarioPublicaSchema>;

export const comentarioPublicoSchema = z.object({
  id: z.string().uuid(),
  reservaId: z.string().uuid(),
  usuarioId: z.string().uuid(),
  usuarioNome: z.string(),
  mensagem: z.string(),
  tipo: z.enum(TIPOS_COMENTARIO),
  imagens: z.array(imagemComentarioPublicaSchema),
  criadoEm: z.string(),
  atualizadoEm: z.string().nullable(),
  /** true quando atualizadoEm existe — evita o frontend duplicar essa comparação. */
  editado: z.boolean(),
  /* Calculados no backend (autor OU admin, e só para comentários de verdade — nunca para
     entradas históricas projetadas) e nunca confiados a partir do frontend, que não tem como
     saber com segurança quem é o usuário autenticado nem reimplementar a regra de RBAC. */
  podeEditar: z.boolean(),
  podeExcluir: z.boolean(),
  /* Eventos históricos trazidos para a timeline (anexos e ocorrências anteriores a esta
     versão). Não são comentários de verdade — não têm tipo editável nem podem ser criados
     —, mas apagá-los da tela para "limpar" a UI seria perder registro operacional. */
  historico: z
    .object({ origem: z.enum(["anexo", "ocorrencia"]), rotulo: z.string() })
    .nullable()
    .optional(),
});
export type ComentarioPublico = z.infer<typeof comentarioPublicoSchema>;
