import { z } from "zod";

// Formato de <input type="datetime-local"> — sem segundos, sem timezone (mesmo padrão
// de simplicidade dos campos data/hora de Reserva, ver schemas/reserva.ts).
const DATA_HORA_REGEX = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export const criarBloqueioSchema = z
  .object({
    // null/ausente = bloqueio global (RN-BLK: cobre todas as plataformas).
    plataformaId: z.string().uuid().nullable().optional(),
    dataInicio: z.string().regex(DATA_HORA_REGEX, "Data/hora inicial inválida."),
    dataFim: z.string().regex(DATA_HORA_REGEX, "Data/hora final inválida."),
    motivo: z.string().trim().min(3, "Motivo deve ter no mínimo 3 caracteres.").max(300),
    // RN-BLK-01: quando há reservas agendada/em_uso conflitantes, a primeira chamada
    // retorna a lista para o frontend; só efetiva o bloqueio com confirmar = true.
    confirmar: z.boolean().optional().default(false),
  })
  .refine((dados) => dados.dataFim > dados.dataInicio, {
    message: "A data/hora final deve ser posterior à inicial.",
    path: ["dataFim"],
  });
export type CriarBloqueioInput = z.infer<typeof criarBloqueioSchema>;

export const bloqueioPublicoSchema = z.object({
  id: z.string().uuid(),
  plataformaId: z.string().uuid().nullable(),
  plataformaNome: z.string().nullable(),
  dataInicio: z.string(),
  dataFim: z.string(),
  motivo: z.string(),
  criadoPorNome: z.string(),
  criadoEm: z.string(),
});
export type BloqueioPublico = z.infer<typeof bloqueioPublicoSchema>;

export const reservaConflitanteBloqueioSchema = z.object({
  id: z.string().uuid(),
  setorNome: z.string(),
  plataformaNome: z.string(),
  data: z.string(),
  horaInicio: z.string(),
  horaFim: z.string(),
});
export type ReservaConflitanteBloqueio = z.infer<typeof reservaConflitanteBloqueioSchema>;
