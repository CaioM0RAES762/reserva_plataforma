import { z } from "zod";
import { CATEGORIAS_PLATAFORMA, PRIORIDADES_RESERVA, STATUS_RESERVA } from "../enums.js";
import { MENSAGEM_TELEFONE_INVALIDO, TELEFONE_TAMANHO_MAXIMO, telefoneValido } from "../telefone.js";
import {
  EMPRESA_TERCEIRIZADA_MAX,
  MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA,
  normalizarEmpresaTerceirizada,
} from "../empresaTerceirizada.js";
import { paginacaoQuerySchema } from "./paginacao.js";

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const reservaPublicaSchema = z.object({
  id: z.string().uuid(),
  setorId: z.string().uuid(),
  setorNome: z.string(),
  /* Nome da empresa quando o setor solicitante é "Terceirizados" (regra em
     empresaTerceirizada.ts). Null em setores internos e em reservas anteriores à migration
     0020 — que genuinamente não têm o dado. */
  empresaTerceirizada: z.string().nullable(),
  solicitanteId: z.string().uuid(),
  solicitanteNome: z.string(),
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  plataformaCategoria: z.enum(CATEGORIAS_PLATAFORMA),
  // Onde a plataforma fica — exibido junto ao motivo na coluna "Recurso" da listagem.
  plataformaLocalizacao: z.string().nullable(),
  /* Telefone de emergência DA PLATAFORMA, projetado na reserva para que quem está em campo
     não precise abrir outra tela para achá-lo. Diferente de `telefoneContato` abaixo: um é
     "para quem ligar se der problema com o equipamento", o outro é "quem está responsável
     por esta reserva agora". */
  plataformaTelefoneEmergencia: z.string().nullable(),
  /* Contato informado NA CRIAÇÃO da reserva — snapshot, não referência ao cadastro do
     usuário. Se o telefone da pessoa mudar depois, a reserva antiga deve continuar
     mostrando o número que valia naquele momento. Nullable porque reservas anteriores à
     migration 0018 genuinamente não têm o dado; toda reserva nova o exige. */
  telefoneContato: z.string().nullable(),
  data: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
  // Corrigir/melhorar Reservas: quantas pessoas vão usar a plataforma/recurso nesta
  // reserva — validado contra Plataforma.capacidade_operadores (pessoas/operadores, NUNCA
  // capacidade, que é a carga em kg) na criação (rota POST /reservas).
  quantidadePessoas: z.number().int(),
  motivo: z.string(),
  prioridade: z.enum(PRIORIDADES_RESERVA),
  status: z.enum(STATUS_RESERVA),
  /* Quem aprovou (fluxo de aprovação, migration 0022). `segundaAprovacaoPorNome` só existe
     em reservas históricas da antiga dupla aprovação — nenhuma operação nova o preenche. */
  aprovadoPorNome: z.string().nullable(),
  segundaAprovacaoPorNome: z.string().nullable(),
  motivoRejeicao: z.string().nullable(),
  /* Substituição por urgência: a reserva substituída é `cancelada` e aponta para a urgente
     que ocupou o horário; o motivo fica gravado ("Substituída por reserva urgente ..."). */
  substituidaPorId: z.string().uuid().nullable(),
  motivoCancelamento: z.string().nullable(),
  /* Minutos de uso contabilizados no horímetro da plataforma (null = ainda não contabilizada
     ou reserva que nunca teve uso). */
  usoContabilizadoMinutos: z.number().int().nullable(),
  horaInicioReal: z.string().nullable(),
  horaFimReal: z.string().nullable(),
  // S9 (RF-RES-03): presente quando a reserva faz parte de uma série semanal — usado
  // pelo frontend para exibir a ação "Cancelar série" no Detalhe da Reserva.
  recorrenciaId: z.string().uuid().nullable(),
  // Automação decidida no momento da criação (herda o padrão da plataforma, com override
  // opcional). Quem executa a transição é o worker do backend — estes campos só refletem a
  // configuração para a UI mostrar o que vai acontecer.
  inicioAutomatico: z.boolean(),
  fimAutomatico: z.boolean(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});
export type ReservaPublica = z.infer<typeof reservaPublicaSchema>;

// S9 (RF-RES-03): até 12 ocorrências semanais, começando na data da primeira reserva.
export const recorrenciaInputSchema = z.object({
  quantidadeOcorrencias: z
    .number()
    .int()
    .min(2, "Uma série semanal exige ao menos 2 ocorrências.")
    .max(12, "Máximo de 12 ocorrências semanais."),
});
export type RecorrenciaInput = z.infer<typeof recorrenciaInputSchema>;

export const criarReservaSchema = z
  .object({
    plataformaId: z.string().uuid("Selecione uma plataforma válida."),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
    horaInicio: z.string().regex(HORA_REGEX, "Horário inicial inválido."),
    horaFim: z.string().regex(HORA_REGEX, "Horário final inválido."),
    // A capacidade máxima é validada no backend contra Plataforma.capacidade_operadores —
    // pessoas/operadores, nunca Plataforma.capacidade (carga em kg) — e nunca confiando em
    // um valor de capacidade vindo do cliente. Ver POST /reservas.
    quantidadePessoas: z
      .number({ invalid_type_error: "Informe a quantidade de pessoas." })
      .int("Quantidade de pessoas deve ser um número inteiro.")
      .min(1, "Informe ao menos 1 pessoa."),
    motivo: z.string().trim().min(3, "Motivo deve ter no mínimo 3 caracteres.").max(300),
    /* Obrigatório: toda reserva precisa dizer quem contatar durante o uso. Guardado na
       própria reserva (snapshot) — ver `telefoneContato` em reservaPublicaSchema. */
    telefoneContato: z
      .string()
      .trim()
      .max(TELEFONE_TAMANHO_MAXIMO)
      .refine(telefoneValido, MENSAGEM_TELEFONE_INVALIDO),
    prioridade: z.enum(PRIORIDADES_RESERVA).default("normal"),
    /* Obrigatória SÓ quando o setor da reserva é "Terceirizados" — o schema não conhece o
       nome do setor (o Admin manda setorId; os demais perfis usam o setor da sessão), então
       a obrigatoriedade é decidida pela rota, com setorExigeEmpresaTerceirizada. Aqui só
       normaliza (trim + espaços colapsados) e limita o tamanho. Vazio = "não informado". */
    empresaTerceirizada: z
      .string()
      .nullish()
      .transform((valor) => normalizarEmpresaTerceirizada(valor))
      .refine((valor) => valor.length <= EMPRESA_TERCEIRIZADA_MAX, MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA),
    recorrencia: recorrenciaInputSchema.optional(),
    // Setor solicitante escolhido no formulário (padrão: o setor do usuário). Omitido = setor
    // da sessão; Admin sem setor próprio (RN-USR-01) precisa informar. O backend confere que
    // o setor existe e está ativo.
    setorId: z.string().uuid("Selecione um setor válido.").optional(),
    // Automação. Omitidos = o backend herda o padrão configurado na plataforma; enviados =
    // override explícito desta reserva. A decisão fica CONGELADA na reserva no momento da
    // criação, então mudar o padrão da plataforma depois não altera reservas já existentes.
    inicioAutomatico: z.boolean().optional(),
    fimAutomatico: z.boolean().optional(),
  })
  .refine((dados) => dados.horaFim > dados.horaInicio, {
    message: "O horário final deve ser após o horário inicial.",
    path: ["horaFim"],
  });
export type CriarReservaInput = z.infer<typeof criarReservaSchema>;

export const conflitoQuerySchema = z.object({
  plataformaId: z.string().uuid(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  horaInicio: z.string().regex(HORA_REGEX, "Horário inicial inválido."),
  horaFim: z.string().regex(HORA_REGEX, "Horário final inválido."),
  ignorarReservaId: z.string().uuid().optional(),
});
export type ConflitoQueryInput = z.infer<typeof conflitoQuerySchema>;

/* Transição manual — fallback administrativo. No fluxo normal quem move a reserva é o
   sincronizador por horário (services/automacaoReserva.service.ts); isto existe para
   corrigir casos de exceção (equipamento liberado antes, uso encerrado adiantado). */
export const alterarStatusReservaSchema = z.object({
  acao: z.enum(["iniciar_uso", "concluir"]),
});
export type AlterarStatusReservaInput = z.infer<typeof alterarStatusReservaSchema>;

/* POST /reservas/:id/aprovar. Os dois flags só têm efeito numa reserva URGENTE que conflita
   com reserva existente: sem eles o backend devolve 409 com os conflitos para o aprovador
   decidir — a substituição nunca acontece implicitamente. */
export const aprovarReservaSchema = z
  .object({
    substituirConflitantes: z.boolean().default(false),
    // Segunda confirmação, exigida à parte quando alguma conflitante está EM USO.
    confirmarInterrupcaoEmUso: z.boolean().default(false),
  })
  .default({});
export type AprovarReservaInput = z.infer<typeof aprovarReservaSchema>;

export const rejeitarReservaSchema = z.object({
  motivo: z.string().trim().min(3, "Informe o motivo da rejeição (mínimo 3 caracteres).").max(500),
});
export type RejeitarReservaInput = z.infer<typeof rejeitarReservaSchema>;

/* Códigos estáveis dos 409 de aprovação — o front decide a UI por eles, nunca pelo texto. */
export const CODIGO_CONFLITO_APROVACAO = "CONFLITO_APROVACAO";
export const CODIGO_CONFLITO_SUBSTITUIVEL = "CONFLITO_SUBSTITUIVEL";
export const CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO = "CONFIRMAR_INTERRUPCAO_EM_USO";

/** Reserva conflitante devolvida ao aprovador antes de uma substituição. */
export interface ConflitoAprovacao {
  id: string;
  plataformaNome: string;
  solicitanteNome: string;
  setorId: string;
  setorNome: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  prioridade: string;
  status: string;
}

export const historicoQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  setor: z.string().uuid().optional(),
  plataforma: z.string().uuid().optional(),
  status: z.enum(STATUS_RESERVA).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida.")
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida.")
    .optional(),
  ...paginacaoQuerySchema.shape,
});
export type HistoricoQueryInput = z.infer<typeof historicoQuerySchema>;

// GET /reservas — antes lia os filtros direto de `request.query` sem validação alguma
// (único ponto do sistema fora do padrão Zod da Seção 2 do MASTER.md): um `?status=xpto`
// era concatenado no SQL como parâmetro e devolvia lista vazia sem explicação, e
// `?data=abc` chegava ao driver como sql.Date inválido, virando erro 500.
export const listarReservasQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(STATUS_RESERVA).optional(),
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")
    .optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida.")
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida.")
    .optional(),
  ...paginacaoQuerySchema.shape,
});
export type ListarReservasQueryInput = z.infer<typeof listarReservasQuerySchema>;

export const conflitoRespostaSchema = z.object({
  conflito: z.boolean(),
  // S9: mensagem pronta para exibição — cobre tanto conflito com outra reserva quanto
  // bloqueio de agenda ativo (RN-RES-11), sem o frontend precisar montar o texto.
  motivo: z.string().nullable(),
  reserva: z
    .object({
      id: z.string().uuid(),
      setorNome: z.string(),
      horaInicio: z.string(),
      horaFim: z.string(),
    })
    .nullable(),
});
export type ConflitoResposta = z.infer<typeof conflitoRespostaSchema>;
