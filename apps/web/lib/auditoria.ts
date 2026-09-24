/* Ponte entre o catálogo de auditoria (@plataformares/shared) e a camada de renderização.
 *
 * O catálogo vive em `shared` porque a API também o usa para gerar o CSV, e por isso não
 * pode importar React nem lucide-react. Este arquivo é o que falta do lado do navegador:
 * o de-para nome do ícone → componente, e a identificação humana do recurso auditado.
 */

import {
  Activity,
  Ban,
  Building2,
  CalendarClock,
  CircleCheck,
  ClipboardCheck,
  Construction,
  MessageSquare,
  Paperclip,
  Pencil,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { traduzirRecurso, type IconeAuditoria } from "@plataformares/shared";

export const ICONES_AUDITORIA: Record<IconeAuditoria, LucideIcon> = {
  CalendarClock,
  Construction,
  UserRound,
  ClipboardCheck,
  TriangleAlert,
  Settings,
  Ban,
  Paperclip,
  MessageSquare,
  Building2,
  ShieldCheck,
  Activity,
  Pencil,
  Trash2,
  CircleCheck,
};

/** Registro como a API o entrega (ver apps/api/src/routes/auditoria.ts). */
export interface RegistroAuditoria {
  id: string;
  usuarioId: string | null;
  usuarioNome: string | null;
  usuarioPerfil: string | null;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  detalhes: unknown;
  criadoEm: string;
  /** Projeção resolvida por JOIN na API — nome atual do recurso. */
  recursoNome: string | null;
  recursoCodigo: string | null;
  recursoContexto: string | null;
}

export interface RecursoIdentificado {
  /** Tipo do recurso ("Reserva", "Plataforma") — a linha de cima da célula. */
  tipo: string;
  /** Como reconhecer este recurso especificamente — a linha forte. */
  nome: string | null;
  /** Código/local/janela — a linha discreta abaixo. */
  detalhe: string | null;
}

/** Código curto e estável derivado do id, no mesmo formato usado na tela de Reservas. */
export function codigoReserva(id: string): string {
  return `RS-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function comoTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === "") return null;
  return String(valor);
}

/**
 * Identificação humana do recurso auditado, com uma regra de precedência que importa
 * para auditoria de verdade: **o snapshot gravado no momento da ação vence a projeção
 * atual**.
 *
 * `criar_plataforma` e `editar_plataforma` gravam `codigo`/`nome` no payload — se a
 * plataforma foi renomeada depois, o registro deve continuar mostrando como ela era
 * identificada naquele momento, não o nome de hoje. Onde não existe snapshot, cai para o
 * JOIN da API (nome atual), que é melhor que exibir um UUID.
 */
export function identificarRecurso(registro: RegistroAuditoria): RecursoIdentificado {
  const tipo = traduzirRecurso(registro.entidade);
  const detalhes = (registro.detalhes && typeof registro.detalhes === "object"
    ? (registro.detalhes as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  // Snapshot histórico no próprio payload.
  const nomeSnapshot = comoTexto(detalhes.nome) ?? comoTexto(detalhes.plataformaNome);
  const codigoSnapshot = comoTexto(detalhes.codigo) ?? comoTexto(detalhes.plataformaCodigo);

  if (registro.entidade === "Reserva") {
    // A reserva é identificada pelo código curto; o equipamento e a janela ficam na
    // linha de apoio, que é o que permite reconhecê-la sem abrir o detalhe.
    const codigo = registro.entidadeId ? codigoReserva(registro.entidadeId) : null;
    const apoio = [registro.recursoNome, registro.recursoContexto].filter(Boolean).join(" · ");
    return { tipo, nome: codigo ? `Reserva ${codigo}` : null, detalhe: apoio || null };
  }

  const nome = nomeSnapshot ?? registro.recursoNome;
  const codigo = codigoSnapshot ?? registro.recursoCodigo;
  const detalhe = codigo ?? registro.recursoContexto;

  // Configurações do sistema não têm instância: o "recurso" é a própria área.
  if (registro.entidade === "ConfiguracaoSistema") {
    return { tipo, nome: "Políticas de reserva", detalhe: null };
  }

  return { tipo, nome, detalhe };
}

const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "18 ago · 10:06" — sem segundos, que não ajudam a varrer a lista. */
export function formatarCarimbo(iso: string): { data: string; hora: string } {
  const d = new Date(iso);
  const ano = d.getFullYear();
  const anoAtual = new Date().getFullYear();
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = MESES_CURTOS[d.getMonth()];
  return {
    data: ano === anoAtual ? `${dia} ${mes}` : `${dia} ${mes} ${ano}`,
    hora: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

/** Timestamp completo, com segundos — só no bloco de detalhes técnicos. */
export function formatarCarimboCompleto(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Data por extenso para o cabeçalho do detalhe: "17 de agosto de 2026 às 11:58". */
export function formatarDataExtensa(iso: string): string {
  const d = new Date(iso);
  const data = d.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${data} às ${hora}`;
}

export const PERFIS_LEGIVEIS: Record<string, string> = {
  admin: "Administrador",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};
