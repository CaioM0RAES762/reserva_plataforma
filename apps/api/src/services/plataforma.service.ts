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
          -- Intervalo fechado no início e ABERTO no fim, coerente com RN-RES-02: uma
          -- reserva que termina às 10:00 não ocupa a plataforma às 10:00 (por isso outra
          -- reserva pode começar exatamente nesse instante — a regra de adjacência já
          -- testada em conflito.service.ts). Com BETWEEN, o fim era inclusivo e a
          -- plataforma aparecia "Reservada" no minuto exato em que já estava livre.
          AND CONVERT(time, GETDATE()) >= r.hora_inicio
          AND CONVERT(time, GETDATE()) < r.hora_fim
      ) THEN 'reservada'
      ELSE 'disponivel'
    END
  `;
}

// Card da frota (S15): % de horas reservadas nos últimos 30 dias sobre o total de horas
// da janela (30 * 24h) — usa o horário real de uso quando registrado (hora_inicio_real/
// hora_fim_real, preenchido ao iniciar/concluir o uso) e cai para o horário planejado
// quando a reserva ainda não foi concluída/usada (ex.: em_uso agora mesmo).
export function sqlUtilizacao30dPlataforma(aliasPlataforma = "p"): string {
  return `(
    SELECT CAST(ROUND(ISNULL(SUM(CASE
             -- Só conta pares de horários coerentes. Uma reserva em_uso tem
             -- hora_inicio_real preenchida e hora_fim_real ainda nula: a combinação
             -- "início real" + "fim planejado" pode ficar invertida (usuário iniciou o
             -- uso depois do fim previsto), e a duração negativa resultante subtraía do
             -- total, chegando a produzir uma utilização negativa no card da frota.
             WHEN COALESCE(r.hora_fim_real, r.hora_fim) > COALESCE(r.hora_inicio_real, r.hora_inicio)
               THEN DATEDIFF(MINUTE,
                      COALESCE(r.hora_inicio_real, r.hora_inicio),
                      COALESCE(r.hora_fim_real, r.hora_fim))
             ELSE 0
           END), 0) * 100.0 / (30 * 24 * 60), 0) AS INT)
    FROM Reserva r
    WHERE r.plataforma_id = ${aliasPlataforma}.id
      AND r.status IN ('concluida', 'em_uso')
      AND r.data >= DATEADD(DAY, -30, CONVERT(date, GETDATE()))
  )`;
}

// Card da frota (S15): evento em destaque, com prioridade —
// 1) ocorrência mais recente enquanto a plataforma está em manutenção (Ocorrencia não
//    tem coluna de "resolvido"; o log é append-only e a manutenção só é revertida
//    manualmente via troca de status, então a ocorrência mais recente é a melhor pista);
// 2) reserva em uso agora mesmo hoje;
// 3) próxima reserva futura (agendada/pendente).
// Deve ser usado no FROM da query (é um OUTER APPLY), não na lista de colunas.
export function sqlEventoAtivoPlataforma(aliasPlataforma = "p"): string {
  return `
    OUTER APPLY (
      SELECT TOP 1 texto, detalhe FROM (
        SELECT TOP 1
          o.descricao AS texto,
          CASE o.gravidade
            WHEN 'alta' THEN 'Ocorrência de gravidade alta — aguardando revisão'
            WHEN 'media' THEN 'Ocorrência de gravidade média — aguardando revisão'
            ELSE 'Aguardando revisão'
          END AS detalhe,
          1 AS prioridade
        FROM Ocorrencia o
        WHERE o.plataforma_id = ${aliasPlataforma}.id AND ${aliasPlataforma}.status = 'manutencao'
        ORDER BY o.criado_em DESC

        UNION ALL

        SELECT TOP 1
          r.motivo AS texto,
          'Em uso até ' + CONVERT(VARCHAR(5), r.hora_fim, 108) AS detalhe,
          2 AS prioridade
        FROM Reserva r
        WHERE r.plataforma_id = ${aliasPlataforma}.id
          AND r.status = 'em_uso'
          AND r.data = CONVERT(date, GETDATE())
        ORDER BY r.hora_inicio DESC

        UNION ALL

        SELECT TOP 1
          r.motivo AS texto,
          'Reservada para ' + CONVERT(VARCHAR(10), r.data, 103) + ' às ' + CONVERT(VARCHAR(5), r.hora_inicio, 108) AS detalhe,
          3 AS prioridade
        FROM Reserva r
        WHERE r.plataforma_id = ${aliasPlataforma}.id
          AND r.status IN ('agendada', 'pendente')
          AND (r.data > CONVERT(date, GETDATE())
               OR (r.data = CONVERT(date, GETDATE()) AND r.hora_inicio > CONVERT(time, GETDATE())))
        ORDER BY r.data ASC, r.hora_inicio ASC
      ) candidatos
      ORDER BY prioridade ASC
    ) evento_ativo
  `;
}

// Selos de norma exibidos no card — derivados de dados já cadastrados (categoria e
// altura máxima), sem introduzir um campo de "conformidade" separado que poderia
// divergir do que a plataforma realmente é:
// - NR-18 (segurança em obras): qualquer categoria além de "sala".
// - NR-35 (trabalho em altura): só quando a altura máxima informada é > 2 m, limite
//   definido pela própria norma.
export function calcularNormasPlataforma(categoria: string, alturaMaximaM: number | null): string[] {
  const normas: string[] = [];
  if (categoria !== "sala") normas.push("NR-18");
  if (alturaMaximaM !== null && alturaMaximaM > 2) normas.push("NR-35");
  return normas;
}
