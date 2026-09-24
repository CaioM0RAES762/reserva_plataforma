import { getPool, sql } from "../db/pool.js";
import type { ChaveConfiguracao, ModoAprovacaoReservas, RegrasAgendaPublicas } from "@plataformares/shared";

interface ConfiguracaoRow {
  chave: string;
  valor: string;
  descricao: string | null;
  atualizado_em: Date;
  atualizado_por_id: string | null;
}

// S12: cache leve em memória do processo — evita reler ConfiguracaoSistema no banco a
// cada criação de reserva (chamado potencialmente em toda POST /reservas). Invalidado
// explicitamente em invalidarCacheConfiguracao(), chamado por salvarConfiguracoes() ao
// final da mesma transação de escrita — nunca há TTL, apenas invalidação por escrita.
let cache: Record<string, string> | null = null;

async function carregarValores(): Promise<Record<string, string>> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<{ chave: string; valor: string }>("SELECT chave, valor FROM ConfiguracaoSistema");
  const valores: Record<string, string> = {};
  for (const row of result.recordset) {
    valores[row.chave] = row.valor;
  }
  return valores;
}

export async function obterValoresConfiguracao(): Promise<Record<string, string>> {
  if (!cache) {
    cache = await carregarValores();
  }
  return cache;
}

export function invalidarCacheConfiguracao(): void {
  cache = null;
}

async function obterNumero(chave: ChaveConfiguracao, padrao: number): Promise<number> {
  const valores = await obterValoresConfiguracao();
  const valor = valores[chave];
  return valor !== undefined ? Number(valor) : padrao;
}

async function obterTexto(chave: ChaveConfiguracao, padrao: string): Promise<string> {
  const valores = await obterValoresConfiguracao();
  return valores[chave] ?? padrao;
}

// RN-RES-09 (S7) — mantido aqui para consolidar toda leitura de ConfiguracaoSistema num
// único ponto; escalonamento.service.ts (S7) passa a chamar esta função em vez de
// consultar o banco diretamente a cada execução do job.
export async function obterSlaAprovacaoUrgenteHoras(): Promise<number> {
  return obterNumero("sla_aprovacao_urgente_horas", 2);
}

// Migration 0023 — política de aprovação. Qualquer valor ausente/desconhecido cai em
// 'manual': na dúvida, a reserva espera decisão humana em vez de ser confirmada sozinha.
export async function obterModoAprovacaoReservas(): Promise<ModoAprovacaoReservas> {
  const valor = await obterTexto("modo_aprovacao_reservas", "manual");
  return valor === "automatica" ? "automatica" : "manual";
}

export interface RegrasReservaConfiguraveis {
  antecedenciaMinimaHoras: number;
  duracaoMaximaHoras: number;
  maxPendentesPorSetor: number;
  horarioExpedienteInicio: string;
  horarioExpedienteFim: string;
}

// RF-CFG-01/02 (S12) — regras de agendamento antes hardcoded/inexistentes, agora lidas
// de ConfiguracaoSistema (com cache) e aplicadas em POST /reservas (conflito.service.ts
// valida a janela; a checagem de max_pendentes_por_setor exige contagem no banco e
// continua na própria rota).
export async function obterRegrasReservaConfiguraveis(): Promise<RegrasReservaConfiguraveis> {
  const [antecedenciaMinimaHoras, duracaoMaximaHoras, maxPendentesPorSetor, horarioExpedienteInicio, horarioExpedienteFim] =
    await Promise.all([
      obterNumero("antecedencia_minima_horas", 2),
      obterNumero("duracao_maxima_horas", 12),
      obterNumero("max_pendentes_por_setor", 5),
      obterTexto("horario_expediente_inicio", "06:00"),
      obterTexto("horario_expediente_fim", "22:00"),
    ]);
  return {
    antecedenciaMinimaHoras,
    duracaoMaximaHoras,
    maxPendentesPorSetor,
    horarioExpedienteInicio,
    horarioExpedienteFim,
  };
}

// Projeção pública das regras de agenda (GET /configuracoes/regras-reserva e o campo `regras`
// de GET /disponibilidade). Sai da MESMA função/cache que a validação de POST /reservas usa:
// o que o Calendário desenha e o que a criação de reserva aceita não podem divergir nem por
// um instante — duas leituras independentes da configuração é como isso acontece.
export async function obterRegrasAgendaPublicas(): Promise<RegrasAgendaPublicas> {
  const regras = await obterRegrasReservaConfiguraveis();
  return {
    horarioExpedienteInicio: regras.horarioExpedienteInicio,
    horarioExpedienteFim: regras.horarioExpedienteFim,
    duracaoMaximaHoras: regras.duracaoMaximaHoras,
    antecedenciaMinimaHoras: regras.antecedenciaMinimaHoras,
  };
}

// Leitura direta (fora do cache) dos dois horários de expediente, dentro da transação do PUT:
// serve para validar "fim > início" quando o Admin envia só um dos dois — o outro vale o que
// já está gravado. UPDLOCK segura as duas linhas até o commit, então dois PUTs concorrentes
// (um mexendo no início, outro no fim) não conseguem juntos deixar o expediente invertido.
export async function lerHorariosExpedienteGravados(
  transaction: sql.Transaction
): Promise<{ inicio: string; fim: string }> {
  const result = await transaction
    .request()
    .query<{ chave: string; valor: string }>(
      `SELECT chave, valor FROM ConfiguracaoSistema WITH (UPDLOCK, ROWLOCK)
       WHERE chave IN ('horario_expediente_inicio', 'horario_expediente_fim')`
    );
  const porChave = new Map(result.recordset.map((linha) => [linha.chave, linha.valor]));
  // Mesmos padrões de obterRegrasReservaConfiguraveis para chave ausente.
  return {
    inicio: porChave.get("horario_expediente_inicio") ?? "06:00",
    fim: porChave.get("horario_expediente_fim") ?? "22:00",
  };
}

export interface ConfiguracaoListada {
  chave: string;
  valor: string;
  descricao: string | null;
  atualizadoEm: Date;
  atualizadoPorId: string | null;
}

// GET /configuracoes (Admin) — lista todas as chaves com metadados, direto do banco
// (não usa o cache: a tela de administração deve sempre refletir o estado mais recente).
export async function listarConfiguracoes(): Promise<ConfiguracaoListada[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<ConfiguracaoRow>(
      "SELECT chave, valor, descricao, atualizado_em, atualizado_por_id FROM ConfiguracaoSistema ORDER BY chave"
    );
  return result.recordset.map((row) => ({
    chave: row.chave,
    valor: row.valor,
    descricao: row.descricao,
    atualizadoEm: row.atualizado_em,
    atualizadoPorId: row.atualizado_por_id,
  }));
}

// PUT /configuracoes (Admin) — grava na mesma transação da rota (invariante de
// auditoria) e invalida o cache ao final, para que a próxima leitura (ex.: a
// validação da criação de reserva seguinte, sem reiniciar o servidor) já veja o
// valor novo.
export async function salvarConfiguracoes(
  transaction: sql.Transaction,
  valores: Partial<Record<ChaveConfiguracao, string>>,
  usuarioId: string
): Promise<void> {
  for (const [chave, valor] of Object.entries(valores)) {
    if (valor === undefined) continue;
    await transaction
      .request()
      .input("chave", sql.VarChar, chave)
      .input("valor", sql.NVarChar, valor)
      .input("usuario_id", sql.UniqueIdentifier, usuarioId)
      .query(
        `UPDATE ConfiguracaoSistema SET valor = @valor, atualizado_em = SYSUTCDATETIME(), atualizado_por_id = @usuario_id
         WHERE chave = @chave`
      );
  }
  invalidarCacheConfiguracao();
}
