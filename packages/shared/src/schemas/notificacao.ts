import { z } from "zod";

export const TIPOS_NOTIFICACAO = [
  "reserva_pendente",
  "reserva_aprovada",
  "reserva_rejeitada",
  "checklist_pendente",
  "ocorrencia_reportada",
  "bloqueio_criado",
  "comentario_novo",
] as const;
export type TipoNotificacao = (typeof TIPOS_NOTIFICACAO)[number];

export const notificacaoPublicaSchema = z.object({
  id: z.string().uuid(),
  tipo: z.enum(TIPOS_NOTIFICACAO),
  titulo: z.string(),
  mensagem: z.string(),
  link: z.string().nullable(),
  lida: z.boolean(),
  criadoEm: z.string(),
});
export type NotificacaoPublica = z.infer<typeof notificacaoPublicaSchema>;
