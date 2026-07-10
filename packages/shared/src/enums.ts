export const PERFIS = ["admin", "gestor_setor", "colaborador"] as const;
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

// SDD §2.4 — categoria determina risco padrão e exigência de checklist (S8).
export const CATEGORIAS_PLATAFORMA = ["elevatoria", "andaime", "sala", "patio", "veiculo", "outro"] as const;
export type CategoriaPlataforma = (typeof CATEGORIAS_PLATAFORMA)[number];

export const RISCOS_PLATAFORMA = ["baixo", "medio", "alto"] as const;
export type RiscoPlataforma = (typeof RISCOS_PLATAFORMA)[number];

// SDD §2.4 — risco padrão por categoria, aplicado na criação da plataforma quando o
// Admin não define um risco explícito.
export const RISCO_PADRAO_POR_CATEGORIA: Record<CategoriaPlataforma, RiscoPlataforma> = {
  elevatoria: "alto",
  andaime: "alto",
  sala: "baixo",
  patio: "medio",
  veiculo: "medio",
  outro: "baixo",
};

export const DOMINIO_EMAIL_PERMITIDO = "@metalsider.com.br";
