import { z } from "zod";
import { PRIORIDADES_RESERVA, STATUS_RESERVA } from "../enums.js";

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const reservaPublicaSchema = z.object({
  id: z.string().uuid(),
  setorId: z.string().uuid(),
  setorNome: z.string(),
  solicitanteId: z.string().uuid(),
  solicitanteNome: z.string(),
  plataformaId: z.string().uuid(),
  plataformaNome: z.string(),
  data: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
  motivo: z.string(),
  prioridade: z.enum(PRIORIDADES_RESERVA),
  status: z.enum(STATUS_RESERVA),
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
