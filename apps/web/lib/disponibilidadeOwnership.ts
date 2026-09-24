import type { IntervaloOcupadoDisponibilidade } from "@plataformares/shared";

export function idsDeUsuarioIguais(vinculadoId: string | undefined, usuarioId: string): boolean {
  return vinculadoId?.toLowerCase() === usuarioId.toLowerCase();
}

/** Ownership é sempre usuário ↔ solicitante; setor serve apenas para visibilidade/permissão. */
export function intervaloPertenceAoUsuario(
  intervalo: IntervaloOcupadoDisponibilidade,
  usuarioId: string
): boolean {
  return intervalo.tipo === "reserva" && idsDeUsuarioIguais(intervalo.solicitanteId, usuarioId);
}

/** Respostas de disponibilidade contêm dados dependentes da sessão e não podem cruzar contas. */
export function chaveCacheDisponibilidade(
  usuarioId: string,
  data: string,
  plataformaId?: string
): string {
  return `${usuarioId}|${data}|${plataformaId ?? "*"}`;
}
