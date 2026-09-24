export const PERFIS = ["admin", "gestor_setor", "colaborador"] as const;
export type Perfil = (typeof PERFIS)[number];

export const TIPOS_CODIGO_VERIFICACAO = ["ativacao_conta", "reset_senha"] as const;
export type TipoCodigoVerificacao = (typeof TIPOS_CODIGO_VERIFICACAO)[number];

export const STATUS_PLATAFORMA = ["disponivel", "reservada", "manutencao", "inativa"] as const;
export type StatusPlataforma = (typeof STATUS_PLATAFORMA)[number];

/* Fluxo da reserva (migration 0022 — retorno da aprovação):
 *
 *     pendente ──aprovar──▶ agendada ──▶ em_uso ──▶ concluida
 *        │                     │            │
 *        └──rejeitar──▶ rejeitada          └────┴──▶ cancelada
 *
 * Colaborador cria PENDENTE; Admin/Gestor criam direto AGENDADA (ver POST /reservas).
 * Pendente NÃO ocupa a plataforma: só agendada/em_uso contam como conflito — a
 * disponibilidade é revalidada no momento da aprovação.
 *
 * Substituição por urgência não tem status próprio: a reserva substituída vira `cancelada`
 * com `substituidaPorId` + motivo (evita um estado redundante no domínio). */
// Ordem preservada da versão anterior: relatórios e exportações listam status nesta ordem.
export const STATUS_RESERVA = ["agendada", "em_uso", "concluida", "cancelada", "pendente", "rejeitada"] as const;
export type StatusReserva = (typeof STATUS_RESERVA)[number];

/** Status que ocupam o horário da plataforma (conflito). Pendente fica de fora de propósito. */
export const STATUS_RESERVA_OCUPAM_PLATAFORMA = ["agendada", "em_uso"] as const;

export const PRIORIDADES_RESERVA = ["normal", "alta", "urgente"] as const;
export type PrioridadeReserva = (typeof PRIORIDADES_RESERVA)[number];

/* Prioridade que habilita o fluxo de urgência: dispensa a antecedência mínima (e, como já
 * era pela RN-RES-06, o horário de expediente) e, na aprovação por Admin/Gestor, permite
 * substituir reserva conflitante mediante confirmação explícita. É o valor MAIS ALTO do
 * enum — "alta" continua sendo prioridade comum. Toda regra de urgência passa por aqui, nunca
 * por comparação com o rótulo exibido na UI. */
export function prioridadeEhUrgente(prioridade: string): prioridade is "urgente" {
  return prioridade === "urgente";
}

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

/* Senha inicial de contas criadas pelo Admin (Administração → Usuários → Novo Usuário).
 * Único ponto de verdade do literal — backend (hash + gravação) e frontend (texto exibido
 * na tela de criação) importam daqui, em vez de cada um ter sua própria cópia da string.
 * NUNCA usada no autocadastro público, cujo fluxo de ativação por e-mail continua intacto. */
export const SENHA_INICIAL_PADRAO = "metal@40";

/* Status de TRATAMENTO de uma não conformidade (migration 0021, tabela NaoConformidade,
 * 1:1 com Comentario.tipo='nao_conformidade'). Não confundir com `tipo` do comentário —
 * `tipo` diz O QUE É o registro (é ou não uma não conformidade); `status` diz o que já foi
 * feito a respeito dele. Nasce sempre 'aberta'. */
export const STATUS_NAO_CONFORMIDADE = ["aberta", "em_analise", "resolvida"] as const;
export type StatusNaoConformidade = (typeof STATUS_NAO_CONFORMIDADE)[number];
