import { RISCO_PADRAO_POR_CATEGORIA, type CategoriaPlataforma, type RiscoPlataforma } from "@plataformares/shared";

// SDD §2.4 — quando o Admin não informa risco explicitamente, aplica o padrão da categoria.
export function resolverRiscoPlataforma(
  categoria: CategoriaPlataforma,
  riscoInformado?: RiscoPlataforma
): RiscoPlataforma {
  return riscoInformado ?? RISCO_PADRAO_POR_CATEGORIA[categoria];
}

export function normalizarCodigoPlataforma(codigo: string): string {
  return codigo.trim().toUpperCase();
}

export function codigoJaCadastrado(codigosExistentes: string[], novoCodigo: string): boolean {
  const normalizado = normalizarCodigoPlataforma(novoCodigo);
  return codigosExistentes.some((codigo) => normalizarCodigoPlataforma(codigo) === normalizado);
}

// RN-PLAT-03: "reservada" é sempre derivado, nunca definido manualmente. Calculado em
// tempo de leitura (nunca persistido) — ver ADR no relatório da Sprint S4.
export function sqlStatusPlataformaDerivado(aliasPlataforma = "p"): string {
  return `
    CASE
      WHEN ${aliasPlataforma}.status IN ('inativa', 'manutencao') THEN ${aliasPlataforma}.status
      WHEN EXISTS (
        SELECT 1 FROM Reserva r
        WHERE r.plataforma_id = ${aliasPlataforma}.id
          AND r.status IN ('agendada', 'em_uso')
          AND r.data = CONVERT(date, GETDATE())
          AND CONVERT(time, GETDATE()) BETWEEN r.hora_inicio AND r.hora_fim
      ) THEN 'reservada'
      ELSE 'disponivel'
    END
  `;
}
