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
  // Migration 0030: quem autoriza substituir reservas por uma urgente.
  "politica_substituicao_reserva_urgente",
] as const;
export type ChaveConfiguracao = (typeof CHAVES_CONFIGURACAO)[number];

/* 'manual' (padrão): Colaborador solicita, reserva fica pendente até Admin/Gestor decidir.
   'automatica': reserva válida de Colaborador já nasce agendada. Em qualquer modo, urgente
   que conflita com reserva existente nasce pendente e exige decisão manual. */
export const MODOS_APROVACAO_RESERVAS = ["manual", "automatica"] as const;
export type ModoAprovacaoReservas = (typeof MODOS_APROVACAO_RESERVAS)[number];

/* Migration 0030 — substituição de reserva existente por uma urgente:
   'todos_aprovadores' (padrão, comportamento anterior): Admin ou qualquer Gestor autoriza;
   'responsaveis_plataforma_ou_admin': só Admin ou Gestor responsável DIRETO pela plataforma.
   Vale só para a decisão de substituir — aprovação sem conflito não muda. */
export const POLITICAS_SUBSTITUICAO_URGENTE = ["todos_aprovadores", "responsaveis_plataforma_ou_admin"] as const;
export type PoliticaSubstituicaoUrgente = (typeof POLITICAS_SUBSTITUICAO_URGENTE)[number];

export const configuracaoPublicaSchema = z.object({
  chave: z.enum(CHAVES_CONFIGURACAO),
  valor: z.string(),
  descricao: z.string().nullable(),
  atualizadoEm: z.string(),
  atualizadoPorId: z.string().uuid().nullable(),
});
export type ConfiguracaoPublica = z.infer<typeof configuracaoPublicaSchema>;

/* Faixas aceitas para os campos numéricos — fonte única para a validação da API e para a tela
   (atributos min/max e a mensagem de erro). Duração máxima ia só até 24h; foi ampliada para
   até 30 dias, para equipamentos que ficam reservados por períodos longos. */
export const LIMITES_CONFIGURACAO = {
  antecedenciaMinimaHoras: { min: 0, max: 720 },
  duracaoMaximaHoras: { min: 1, max: 720 },
  maxPendentesPorSetor: { min: 1, max: 100 },
  slaAprovacaoUrgenteHoras: { min: 1, max: 72 },
} as const;
export type CampoNumericoConfiguracao = keyof typeof LIMITES_CONFIGURACAO;

function numeroConfiguracao(campo: CampoNumericoConfiguracao) {
  const { min, max } = LIMITES_CONFIGURACAO[campo];
  const mensagem = `Use um número inteiro entre ${min} e ${max}.`;
  return z
    .number({ invalid_type_error: mensagem })
    .int(mensagem)
    .min(min, mensagem)
    .max(max, mensagem)
    .optional();
}

export const atualizarConfiguracoesSchema = z
  .object({
    antecedenciaMinimaHoras: numeroConfiguracao("antecedenciaMinimaHoras"),
    duracaoMaximaHoras: numeroConfiguracao("duracaoMaximaHoras"),
    maxPendentesPorSetor: numeroConfiguracao("maxPendentesPorSetor"),
    horarioExpedienteInicio: z.string().regex(HORA_REGEX, "Use o formato HH:mm").optional(),
    horarioExpedienteFim: z.string().regex(HORA_REGEX, "Use o formato HH:mm").optional(),
    slaAprovacaoUrgenteHoras: numeroConfiguracao("slaAprovacaoUrgenteHoras"),
    modoAprovacaoReservas: z.enum(MODOS_APROVACAO_RESERVAS).optional(),
    politicaSubstituicaoReservaUrgente: z.enum(POLITICAS_SUBSTITUICAO_URGENTE).optional(),
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
