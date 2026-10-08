import { z } from "zod";
import { CATEGORIAS_PLATAFORMA } from "../enums.js";

// SDD §4.3/§6.5/§7 (RF-CHK-*/RN-CHK-*). Templates de checklist só existem para as
// categorias que podem exigi-lo — sala/pátio nunca têm checklist (SDD §2.4).
export const CATEGORIAS_COM_TEMPLATE_CHECKLIST = ["elevatoria", "andaime", "veiculo", "outro"] as const;

// Correção do fluxo de Checklist: cada resposta de item tem 3 estados possíveis, não mais
// um booleano conforme/não-conforme. "Não aplicável" existia como necessidade real (um item
// do template que não se aplica a uma reserva específica) mas antes só podia ser mascarado
// como conforme=true (escondendo o dado) ou conforme=false (bloqueando aprovação à toa).
export const RESULTADOS_ITEM_CHECKLIST = ["conforme", "nao_conforme", "nao_aplicavel"] as const;
export type ResultadoItemChecklist = (typeof RESULTADOS_ITEM_CHECKLIST)[number];

export const checklistTemplateSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  descricao: z.string().nullable(),
  categoriaPlataforma: z.enum(CATEGORIAS_PLATAFORMA),
  ativo: z.boolean(),
  // Usados pela tela "Gerenciar templates" ("6 questões · 3 plataformas vinculadas") —
  // contados no backend numa única consulta, nunca N+1 a partir do frontend.
  totalQuestoes: z.number().int().nonnegative(),
  totalPlataformasVinculadas: z.number().int().nonnegative(),
});
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

export const criarChecklistTemplateSchema = z.object({
  nome: z.string().trim().min(3, "Nome deve ter no mínimo 3 caracteres.").max(150),
  descricao: z.string().trim().max(400).optional(),
  categoriaPlataforma: z.enum(CATEGORIAS_PLATAFORMA).default("outro"),
});
export type CriarChecklistTemplateInput = z.infer<typeof criarChecklistTemplateSchema>;

export const editarChecklistTemplateSchema = criarChecklistTemplateSchema.extend({
  ativo: z.boolean().default(true),
});
export type EditarChecklistTemplateInput = z.infer<typeof editarChecklistTemplateSchema>;

export const checklistItemTemplateSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  descricao: z.string(),
  ordem: z.number().int(),
  obrigatorio: z.boolean(),
  // Regra distinta de `obrigatorio`: "obrigatória" diz que a questão precisa ser respondida
  // para o checklist ser finalizado; esta diz se uma resposta NÃO CONFORME nela impede a
  // aprovação da reserva. Uma questão pode ser obrigatória sem ser impeditiva (ex.:
  // "Documentação disponível") — antes as duas coisas eram o mesmo campo.
  bloqueiaAprovacao: z.boolean(),
  ativo: z.boolean(),
});
export type ChecklistItemTemplate = z.infer<typeof checklistItemTemplateSchema>;

export const criarChecklistItemTemplateSchema = z.object({
  templateId: z.string().uuid(),
  descricao: z.string().trim().min(3, "Descrição deve ter no mínimo 3 caracteres.").max(300),
  // Omitida = vai para o fim da lista (o backend calcula MAX(ordem) + 1). Só o
  // reordenamento explícito (PUT .../itens/ordem) define ordens em lote.
  ordem: z.number().int().nonnegative().optional(),
  obrigatorio: z.boolean().default(true),
  bloqueiaAprovacao: z.boolean().default(true),
});
export type CriarChecklistItemTemplateInput = z.infer<typeof criarChecklistItemTemplateSchema>;

export const editarChecklistItemTemplateSchema = z.object({
  descricao: z.string().trim().min(3, "Descrição deve ter no mínimo 3 caracteres.").max(300),
  obrigatorio: z.boolean().default(true),
  bloqueiaAprovacao: z.boolean().default(true),
});
export type EditarChecklistItemTemplateInput = z.infer<typeof editarChecklistItemTemplateSchema>;

// Reordenação em lote: a lista completa de ids na ordem desejada. Em lote (e não um PATCH
// de `ordem` por item) porque mover uma questão renumera várias — enviar item a item
// deixaria o template numa ordem inconsistente entre as requisições.
export const reordenarChecklistItensSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1, "Informe a ordem dos itens."),
});
export type ReordenarChecklistItensInput = z.infer<typeof reordenarChecklistItensSchema>;

// RN-CHK-01: observacao obrigatória quando resultado = nao_conforme — reforçado no backend
// (checklist.service.ts) porque depende do valor de outro campo do mesmo objeto.
export const checklistRespostaInputSchema = z.object({
  itemId: z.string().uuid(),
  resultado: z.enum(RESULTADOS_ITEM_CHECKLIST),
  observacao: z.string().trim().max(300).optional(),
  // Evidência fotográfica opcional (RF-CHK-04) — data URL (base64), armazenamento
  // simplificado nesta sprint via storage.service.ts (ver ADR no relatório S8).
  fotoBase64: z.string().optional(),
});
export type ChecklistRespostaInput = z.infer<typeof checklistRespostaInputSchema>;

// Mesmo formato usado tanto para salvar progresso (PUT — aceita respostas parciais, RF-CHK-06)
// quanto para finalizar (POST /finalizar — exige todos os itens obrigatórios respondidos).
export const preencherChecklistSchema = z.object({
  respostas: z.array(checklistRespostaInputSchema).min(1, "Informe ao menos uma resposta."),
});
export type PreencherChecklistInput = z.infer<typeof preencherChecklistSchema>;

export const checklistRespostaPublicaSchema = z.object({
  itemId: z.string().uuid(),
  descricao: z.string(),
  ordem: z.number().int(),
  obrigatorio: z.boolean(),
  bloqueiaAprovacao: z.boolean(),
  resultado: z.enum(RESULTADOS_ITEM_CHECKLIST).nullable(),
  observacao: z.string().nullable(),
  fotoUrl: z.string().nullable(),
});
export type ChecklistRespostaPublica = z.infer<typeof checklistRespostaPublicaSchema>;

export const checklistReservaSchema = z.object({
  requerChecklist: z.boolean(),
  templateNome: z.string().nullable(),
  // Uma execução finalizada é renderizada a partir do SNAPSHOT gravado nas respostas, não
  // das questões atuais do template — editar o template depois não reescreve o histórico.
  // `true` sinaliza à UI que aquilo é o registro imutável da execução.
  apartirDeSnapshot: z.boolean(),
  // Distingue rascunho (progresso salvo, gate de aprovação ainda bloqueado) de finalizado
  // (RF-CHK-06/RN-CHK-03 — só a partir daqui o checklist conta para liberar a aprovação).
  finalizadoEm: z.string().nullable(),
  todosConformes: z.boolean().nullable(),
  preenchidoPorNome: z.string().nullable(),
  preenchidoEm: z.string().nullable(),
  totalItens: z.number().int(),
  totalRespondidos: z.number().int(),
  itens: z.array(checklistRespostaPublicaSchema),
});
export type ChecklistReserva = z.infer<typeof checklistReservaSchema>;

// RF-CHK-07 — central de checklists: uma linha por reserva que exige checklist, com a
// situação já derivada no backend (fonte única de verdade, não recalculada no frontend).
export const SITUACOES_CHECKLIST = ["pendente", "em_preenchimento", "concluido", "nao_conforme"] as const;
export type SituacaoChecklist = (typeof SITUACOES_CHECKLIST)[number];

export const checklistListaItemSchema = z.object({
  reservaId: z.string().uuid(),
  reservaStatus: z.string(),
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  plataformaCategoria: z.enum(CATEGORIAS_PLATAFORMA),
  setorNome: z.string(),
  responsavelNome: z.string(),
  // Comparado ao id do usuário logado para destacar "meu checklist" — sempre por id, nunca
  // por nome, mesmo critério já usado na listagem de Reservas (dois usuários podem ter
  // nomes iguais).
  responsavelId: z.string().uuid(),
  data: z.string(),
  /** Último dia da reserva (migration 0029); igual a `data` numa reserva de um dia. */
  dataFim: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
  templateNome: z.string().nullable(),
  situacao: z.enum(SITUACOES_CHECKLIST),
  totalItens: z.number().int(),
  totalRespondidos: z.number().int(),
});
export type ChecklistListaItem = z.infer<typeof checklistListaItemSchema>;
