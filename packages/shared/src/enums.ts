export const PERFIS = ["admin", "colaborador"] as const;
export type Perfil = (typeof PERFIS)[number];

export const TIPOS_CODIGO_VERIFICACAO = ["ativacao_conta", "reset_senha"] as const;
export type TipoCodigoVerificacao = (typeof TIPOS_CODIGO_VERIFICACAO)[number];

export const STATUS_PLATAFORMA = ["disponivel", "reservada", "manutencao", "inativa"] as const;
export type StatusPlataforma = (typeof STATUS_PLATAFORMA)[number];

export const STATUS_RESERVA = [
  "pendente",
  "agendada",
  "em_uso",
  "concluida",
  "cancelada",
  "rejeitada",
] as const;
export type StatusReserva = (typeof STATUS_RESERVA)[number];

export const PRIORIDADES_RESERVA = ["normal", "alta", "urgente"] as const;
export type PrioridadeReserva = (typeof PRIORIDADES_RESERVA)[number];

export const DOMINIO_EMAIL_PERMITIDO = "@metalsider.com.br";
