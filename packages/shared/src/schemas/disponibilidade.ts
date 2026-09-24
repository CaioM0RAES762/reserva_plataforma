import { z } from "zod";
import type { CategoriaPlataforma, StatusPlataforma, StatusReserva } from "../enums.js";
import type { FaixaMinutos } from "../disponibilidade.js";

const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------
// GET /api/v1/configuracoes/regras-reserva  (qualquer perfil autenticado)
// ---------------------------------------------------------------------------------------
// GET /api/v1/configuracoes é exclusivo do Admin (lista todas as chaves, com metadados).
// Calendário e "Nova Reserva" precisam SÓ das regras de agenda e são usados por todos os
// perfis — por isso existe esta projeção pública e pequena, lida sempre do mesmo cache/
// fonte (ConfiguracaoSistema) que a validação de POST /reservas usa.
export interface RegrasAgendaPublicas {
  /** "HH:mm" — configuração `horario_expediente_inicio`. */
  horarioExpedienteInicio: string;
  /** "HH:mm" — configuração `horario_expediente_fim` (23:59 = dia inteiro). */
  horarioExpedienteFim: string;
  duracaoMaximaHoras: number;
  antecedenciaMinimaHoras: number;
}

// ---------------------------------------------------------------------------------------
// GET /api/v1/disponibilidade?data=YYYY-MM-DD[&plataformaId=uuid]  (qualquer perfil)
// ---------------------------------------------------------------------------------------
// UMA consulta agregada devolve todas as plataformas do dia (nada de N requisições por
// plataforma). Reaproveita as mesmas regras de conflito de POST /reservas: estados que
// ocupam horário = agendada/em_uso (pendente não ocupa — migration 0022) (+ concluida, só como histórico do
// dia), e bloqueios de agenda globais ou da plataforma.
export const disponibilidadeQuerySchema = z.object({
  data: z.string().regex(DATA_REGEX, "Data inválida."),
  plataformaId: z.string().uuid().optional(),
});
export type DisponibilidadeQueryInput = z.infer<typeof disponibilidadeQuerySchema>;

export type TipoIntervaloOcupado = "reserva" | "bloqueio_plataforma" | "bloqueio_global";

export interface IntervaloOcupadoDisponibilidade extends FaixaMinutos {
  tipo: TipoIntervaloOcupado;
  /** id da Reserva ou do BloqueioAgenda. */
  id: string;
  /** Só em `tipo: "reserva"`. `concluida` = já encerrada (histórico do dia). */
  status?: StatusReserva;
  /** Só em `tipo: "reserva"`. Mesmo dado que a mensagem de conflito já expõe a qualquer perfil. */
  setorNome?: string;
  /** Só em `tipo: "reserva"`: usuário realmente vinculado à reserva. Ownership nunca é inferido pelo setor. */
  solicitanteId?: string;
  /** Só em `tipo: "reserva"`: prioridade ("urgente" pendente sobre reserva confirmada = decisão de substituição). */
  prioridade?: string;
  /** Bloqueio: motivo do bloqueio (já público na mensagem de conflito). Reserva: motivo, SÓ para Admin ou reserva do próprio setor; senão null. */
  motivo?: string | null;
}

export interface PlataformaDisponibilidade {
  id: string;
  codigo: string;
  nome: string;
  categoria: CategoriaPlataforma;
  localizacao: string | null;
  /** Status derivado da plataforma AGORA (disponivel | reservada=em uso | manutencao | inativa). */
  status: StatusPlataforma;
  capacidadeOperadores: number | null;
  /** manutencao|inativa: a plataforma não pode ser reservada em nenhum horário. */
  indisponivel: boolean;
  /** Ocupações do dia (limitadas a 0..1440), ordenadas por início. Reservas canceladas NÃO aparecem. */
  intervalos: IntervaloOcupadoDisponibilidade[];
}

export interface DisponibilidadeDiaResposta {
  data: string;
  regras: RegrasAgendaPublicas;
  /** Minuto atual em Brasília quando `data` é hoje; senão null. */
  agoraMin: number | null;
  /**
   * Nenhum início antes deste minuto é aceito pela antecedência mínima:
   * 0 = sem corte (data futura); agora+antecedência = hoje; 1440 = data passada.
   */
  inicioMinimoMin: number;
  plataformas: PlataformaDisponibilidade[];
}

// GET /api/v1/disponibilidade/proximo — "Ver próximo horário disponível".
export const proximoHorarioQuerySchema = z.object({
  plataformaId: z.string().uuid(),
  data: z.string().regex(DATA_REGEX, "Data inválida."),
  duracaoMinutos: z.coerce.number().int().min(15).max(24 * 60).default(60),
  limiteDias: z.coerce.number().int().min(1).max(30).default(14),
});
export type ProximoHorarioQueryInput = z.infer<typeof proximoHorarioQuerySchema>;

export interface ProximoHorarioResposta {
  encontrado: boolean;
  data: string | null;
  inicioMin: number | null;
  fimMin: number | null;
}

/**
 * Corpo do 409 de POST /reservas quando o horário deixou de estar livre entre a escolha e o
 * envio (concorrência) — o front troca a mensagem técnica por "Esse horário acabou de ficar
 * indisponível." e recarrega a disponibilidade.
 */
export const CODIGO_ERRO_HORARIO_INDISPONIVEL = "horario_indisponivel";
