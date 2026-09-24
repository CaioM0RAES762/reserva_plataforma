import { z } from "zod";

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

// SDD §4.3/§17.10 — chaves de ConfiguracaoSistema. `sla_aprovacao_urgente_horas`
// nasceu em S7; as demais 5 nascem em S12 (RF-CFG-01/02).
export const CHAVES_CONFIGURACAO = [
  "antecedencia_minima_horas",
  "duracao_maxima_horas",
  "max_pendentes_por_setor",
  "horario_expediente_inicio",
  "horario_expediente_fim",
  "sla_aprovacao_urgente_horas",
  // Migration 0023: política de aprovação de reservas de colaboradores.
  "modo_aprovacao_reservas",
] as const;
export type ChaveConfiguracao = (typeof CHAVES_CONFIGURACAO)[number];

/* 'manual' (padrão): Colaborador solicita, reserva fica pendente até Admin/Gestor decidir.
   'automatica': reserva válida de Colaborador já nasce agendada. Em qualquer modo, urgente
   que conflita com reserva existente nasce pendente e exige decisão manual. */
export const MODOS_APROVACAO_RESERVAS = ["manual", "automatica"] as const;
export type ModoAprovacaoReservas = (typeof MODOS_APROVACAO_RESERVAS)[number];

export const configuracaoPublicaSchema = z.object({
  chave: z.enum(CHAVES_CONFIGURACAO),
  valor: z.string(),
  descricao: z.string().nullable(),
  atualizadoEm: z.string(),
  atualizadoPorId: z.string().uuid().nullable(),
});
export type ConfiguracaoPublica = z.infer<typeof configuracaoPublicaSchema>;

export const atualizarConfiguracoesSchema = z
  .object({
    antecedenciaMinimaHoras: z.number().int().min(0).max(720).optional(),
    duracaoMaximaHoras: z.number().int().min(1).max(24).optional(),
    maxPendentesPorSetor: z.number().int().min(1).max(100).optional(),
    horarioExpedienteInicio: z.string().regex(HORA_REGEX, "Use o formato HH:mm").optional(),
    horarioExpedienteFim: z.string().regex(HORA_REGEX, "Use o formato HH:mm").optional(),
    slaAprovacaoUrgenteHoras: z.number().int().min(1).max(72).optional(),
    modoAprovacaoReservas: z.enum(MODOS_APROVACAO_RESERVAS).optional(),
  })
  .refine((dados) => Object.keys(dados).length > 0, {
    message: "Informe ao menos um campo para atualizar.",
  })
  .refine(
    (dados) =>
      !dados.horarioExpedienteInicio ||
      !dados.horarioExpedienteFim ||
      dados.horarioExpedienteFim > dados.horarioExpedienteInicio,
    {
      message: "O horário de fim do expediente deve ser após o horário de início.",
      path: ["horarioExpedienteFim"],
    }
  );
export type AtualizarConfiguracoesInput = z.infer<typeof atualizarConfiguracoesSchema>;
