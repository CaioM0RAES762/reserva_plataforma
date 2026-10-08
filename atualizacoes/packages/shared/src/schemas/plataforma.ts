import { z } from "zod";
import { RISCOS_PLATAFORMA, STATUS_PLATAFORMA } from "../enums.js";
import { MENSAGEM_TELEFONE_INVALIDO, TELEFONE_TAMANHO_MAXIMO, telefoneValido } from "../telefone.js";

// Mesmo formato de S11 (Anexo/checklist) — data URL base64, mime real verificado no
// backend por magic bytes (SDD §12), nunca confiando no prefixo declarado aqui.
const DATA_URL_REGEX = /^data:[\w.+-]+\/[\w.+-]+;base64,.+$/;

export const eventoAtivoPlataformaSchema = z.object({
  texto: z.string(),
  detalhe: z.string().nullable(),
});
export type EventoAtivoPlataforma = z.infer<typeof eventoAtivoPlataformaSchema>;

/* Até 4 imagens por plataforma (migration 0025). A principal é sempre a de ordem 0 e é a
   capa do card; `url` é URL de leitura assinada de curta duração, nunca a chave do arquivo. */
export const LIMITE_IMAGENS_PLATAFORMA = 4;
export const MIMES_IMAGEM_PLATAFORMA = ["image/jpeg", "image/png", "image/webp"] as const;

export const imagemPlataformaSchema = z.object({
  id: z.string().uuid(),
  url: z.string().nullable(),
  ordem: z.number().int(),
  principal: z.boolean(),
});
export type ImagemPlataforma = z.infer<typeof imagemPlataformaSchema>;

export const adicionarImagemPlataformaSchema = z.object({
  imagemBase64: z.string().regex(DATA_URL_REGEX, "Formato inválido — esperado data URL base64."),
});
export type AdicionarImagemPlataformaInput = z.infer<typeof adicionarImagemPlataformaSchema>;

export const plataformaPublicaSchema = z.object({
  id: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  localizacao: z.string().nullable(),
  /* Contato acionado quando algo dá errado COM O EQUIPAMENTO durante o uso. Vive na
     plataforma (não na reserva) porque é uma característica do ativo: a mesma linha de
     emergência vale para toda reserva que o utilize. */
  telefoneEmergencia: z.string().nullable(),
  capacidade: z.number().int().nullable(),
  status: z.enum(STATUS_PLATAFORMA),
  /* Código da categoria (CategoriaEquipamento, administrável — migration 0025). Os seis
     códigos históricos continuam valendo; o nome exibido vem de `categoriaNome`. */
  categoria: z.string(),
  categoriaNome: z.string().nullable(),
  categoriaAtiva: z.boolean(),
  // Texto livre e opcional (Dingli, JLG, Genie...).
  marca: z.string().nullable(),
  risco: z.enum(RISCOS_PLATAFORMA),
  aprovacaoAutomatica: z.boolean(),
  observacoes: z.string().nullable(),
  // URL de leitura da imagem PRINCIPAL — derivada de `imagens`, nunca uma segunda fonte.
  imagemUrl: z.string().nullable(),
  imagens: z.array(imagemPlataformaSchema),
  tipoEquipamento: z.string().nullable(),
  alturaMaximaM: z.number().nullable(),
  capacidadeOperadores: z.number().int().nullable(),
  /* Horímetro (migration 0022). `horimetroHoras` é o BASELINE cadastrado/corrigido pelo
     Admin; `horimetroUsoMinutos` é o uso real acumulado pelas reservas concluídas desde
     então; `horimetroAtualHoras` = baseline + uso (null quando não há baseline nem uso). */
  horimetroHoras: z.number().int().nullable(),
  horimetroUsoMinutos: z.number().int(),
  horimetroAtualHoras: z.number().nullable(),
  // % de horas reservadas nos últimos 30 dias — calculado em tempo de leitura a partir
  // de Reserva, nunca persistido.
  utilizacao30d: z.number().int().nullable(),
  // Ocorrência aberta / reserva em uso / próxima reserva, o que for mais relevante agora.
  evento: eventoAtivoPlataformaSchema.nullable(),
  // NR-18/NR-35 — derivados de categoria/altura máxima, não é um campo cadastrado à parte.
  // Continuam expostos: são informação de segurança do equipamento, independente de
  // existir ou não checklist no fluxo de reserva.
  normas: z.array(z.string()),
  // Só pré-preenchem o formulário de nova reserva — a decisão que o job de automação lê é
  // sempre a gravada na própria reserva. Ambos nascem `true` desde a migration 0018:
  // iniciar/concluir por horário é o comportamento padrão do produto.
  inicioAutomaticoPadrao: z.boolean(),
  fimAutomaticoPadrao: z.boolean(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});
export type PlataformaPublica = z.infer<typeof plataformaPublicaSchema>;

export const criarPlataformaSchema = z.object({
  codigo: z.string().trim().min(2, "Código deve ter no mínimo 2 caracteres").max(30),
  nome: z.string().trim().min(2, "Nome deve ter no mínimo 2 caracteres").max(120),
  localizacao: z.string().trim().max(160).optional(),
  /* Opcional no cadastro (nem todo ativo tem uma linha própria), mas validado quando
     informado — um telefone de emergência errado é pior que nenhum. */
  telefoneEmergencia: z
    .string()
    .trim()
    .max(TELEFONE_TAMANHO_MAXIMO)
    .refine((valor) => valor === "" || telefoneValido(valor), MENSAGEM_TELEFONE_INVALIDO)
    .optional(),
  capacidade: z.number().int().positive().optional(),
  // Validada no backend contra CategoriaEquipamento (existente e ativa).
  categoria: z.string().trim().min(1, "Selecione a categoria.").max(20).default("elevatoria"),
  marca: z.string().trim().max(60, "Marca deve ter no máximo 60 caracteres.").optional(),
  // RN: risco tem default por categoria (SDD §2.4) — quando omitido, o backend aplica
  // RISCO_PADRAO_POR_CATEGORIA; quando informado, o Admin pode sobrescrever.
  risco: z.enum(RISCOS_PLATAFORMA).optional(),
  aprovacaoAutomatica: z.boolean().default(false),
  observacoes: z.string().trim().max(500).optional(),
  tipoEquipamento: z.string().trim().max(80).optional(),
  alturaMaximaM: z.number().positive().max(999).optional(),
  capacidadeOperadores: z.number().int().positive().max(50).optional(),
  horimetroHoras: z.number().int().nonnegative().optional(),
  // Imagens NÃO vêm aqui: são geridas uma a uma em /plataformas/:id/imagens (até 4).
  /* Padrões de automação herdados por novas reservas desta plataforma. Default `true`:
     iniciar e concluir por horário é o comportamento normal do fluxo, não um opt-in. */
  inicioAutomaticoPadrao: z.boolean().default(true),
  fimAutomaticoPadrao: z.boolean().default(true),
  /* Setor responsável (migration 0030). O ADMIN escolhe (obrigatório no cadastro); para o
     Gestor o backend usa sempre o setor atual dele e ignora o que vier aqui. */
  setorId: z.string().uuid("Selecione um setor válido.").nullable().optional(),
});
export type CriarPlataformaInput = z.infer<typeof criarPlataformaSchema>;

/* Por que o usuário pode gerenciar a plataforma — devolvido pela API junto com `podeEditar`
   (sem expor dados de terceiros). null = não pode. */
export const ORIGENS_GESTAO_PLATAFORMA = ["admin", "criador", "setor", "responsavel"] as const;
export type OrigemGestaoPlataforma = (typeof ORIGENS_GESTAO_PLATAFORMA)[number];

// Gestores responsáveis por plataforma (migration 0030) — Admin atribui/remove.
export const adicionarResponsaveisPlataformaSchema = z.object({
  gestorIds: z
    .array(z.string().uuid("Gestor inválido."))
    .min(1, "Selecione ao menos um gestor.")
    .max(50, "Selecione no máximo 50 gestores por vez."),
});
export type AdicionarResponsaveisPlataformaInput = z.infer<typeof adicionarResponsaveisPlataformaSchema>;

export interface ResponsavelPlataforma {
  gestorId: string;
  nome: string;
  email: string;
  setorNome: string | null;
  /** false = desativado ou deixou de ser Gestor: a associação continua, mas não concede acesso. */
  concedeAcesso: boolean;
  atribuidoEm: string;
  atribuidoPorNome: string | null;
}

export interface PlataformaComResponsaveis {
  plataformaId: string;
  codigo: string;
  nome: string;
  categoriaNome: string | null;
  setorId: string | null;
  setorNome: string | null;
  status: string;
  responsaveis: ResponsavelPlataforma[];
}

export const editarPlataformaSchema = criarPlataformaSchema;
export type EditarPlataformaInput = z.infer<typeof editarPlataformaSchema>;

// RN-PLAT-03: "reservada" é sempre derivado (nunca definido manualmente) — excluído das opções aqui.
const STATUS_EDITAVEIS_MANUALMENTE = ["disponivel", "manutencao", "inativa"] as const;
export const atualizarStatusPlataformaSchema = z.object({
  status: z.enum(STATUS_EDITAVEIS_MANUALMENTE),
});
export type AtualizarStatusPlataformaInput = z.infer<typeof atualizarStatusPlataformaSchema>;

export const dashboardKpisSchema = z.object({
  totalPlataformas: z.number().int().nonnegative(),
  disponiveis: z.number().int().nonnegative(),
});
export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;

// ---------------------------------------------------------------------------
// Categorias de equipamento (migration 0025) — administradas pelo Admin em Configurações.
// ---------------------------------------------------------------------------

export const categoriaEquipamentoSchema = z.object({
  id: z.string().uuid(),
  codigo: z.string(),
  nome: z.string(),
  ativo: z.boolean(),
  // Plataformas que usam a categoria — informativo (desativar não afeta as existentes).
  emUso: z.number().int().nonnegative(),
});
export type CategoriaEquipamento = z.infer<typeof categoriaEquipamentoSchema>;

const nomeCategoriaSchema = z
  .string()
  .trim()
  .min(2, "Nome deve ter no mínimo 2 caracteres.")
  .max(60, "Nome deve ter no máximo 60 caracteres.");

export const criarCategoriaEquipamentoSchema = z.object({ nome: nomeCategoriaSchema });
export type CriarCategoriaEquipamentoInput = z.infer<typeof criarCategoriaEquipamentoSchema>;

export const editarCategoriaEquipamentoSchema = z
  .object({ nome: nomeCategoriaSchema.optional(), ativo: z.boolean().optional() })
  .refine((v) => v.nome !== undefined || v.ativo !== undefined, "Nada para alterar.");
export type EditarCategoriaEquipamentoInput = z.infer<typeof editarCategoriaEquipamentoSchema>;
