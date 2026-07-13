import { z } from "zod";
import { CATEGORIAS_PLATAFORMA, PRIORIDADES_RESERVA, STATUS_RESERVA } from "../enums.js";

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const reservaPublicaSchema = z.object({
  id: z.string().uuid(),
  setorId: z.string().uuid(),
  setorNome: z.string(),
  solicitanteId: z.string().uuid(),
  solicitanteNome: z.string(),
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  // S8 (RN-RES-12): usada pelo frontend para decidir se mostra a seção de Checklist
  // de Segurança e para espelhar o bloqueio de "Iniciar Uso" — o backend é sempre a
  // fonte de verdade (rota /reservas/:id/status revalida via requerChecklist).
  plataformaCategoria: z.enum(CATEGORIAS_PLATAFORMA),
  data: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
  motivo: z.string(),
  prioridade: z.enum(PRIORIDADES_RESERVA),
  status: z.enum(STATUS_RESERVA),
  aprovadoPorNome: z.string().nullable(),
  segundaAprovacaoPorNome: z.string().nullable(),
  motivoRejeicao: z.string().nullable(),
  horaInicioReal: z.string().nullable(),
  horaFimReal: z.string().nullable(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});
export type ReservaPublica = z.infer<typeof reservaPublicaSchema>;

export const criarReservaSchema = z
  .object({
    plataformaId: z.string().uuid("Selecione uma plataforma válida."),
    data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
    horaInicio: z.string().regex(HORA_REGEX, "Horário inicial inválido."),
    horaFim: z.string().regex(HORA_REGEX, "Horário final inválido."),
    motivo: z.string().trim().min(3, "Motivo deve ter no mínimo 3 caracteres.").max(300),
    prioridade: z.enum(PRIORIDADES_RESERVA).default("normal"),
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

export const rejeitarReservaSchema = z.object({
  motivo: z.string().trim().min(5, "Motivo da rejeição deve ter no mínimo 5 caracteres.").max(500),
});
export type RejeitarReservaInput = z.infer<typeof rejeitarReservaSchema>;

export const alterarStatusReservaSchema = z.object({
  acao: z.enum(["iniciar_uso", "concluir"]),
});
export type AlterarStatusReservaInput = z.infer<typeof alterarStatusReservaSchema>;

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
});
export type HistoricoQueryInput = z.infer<typeof historicoQuerySchema>;

export const conflitoRespostaSchema = z.object({
  conflito: z.boolean(),
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
