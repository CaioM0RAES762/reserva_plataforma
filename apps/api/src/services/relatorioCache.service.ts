import { Redis as IORedis } from "ioredis";
import "dotenv/config";

// S13 (SDD §11 — "rotas de relatório usam cache Redis com TTL de 15 minutos"): TTL é
// suficiente por si só (não é exigida invalidação ativa em escrita, ao contrário de
// configuracao.service.ts em S12) — mesmo padrão de conexão de rateLimit.ts (S1).
const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379");

const TTL_SEGUNDOS = 15 * 60;

export interface ResultadoCache<T> {
  valor: T;
  origem: "cache" | "calculado";
}

export interface ChaveCacheRelatorio {
  relatorio: string;
  dateFrom: string;
  dateTo: string;
  // Escopo do relatório: setor específico (Gestor de Setor, ou Admin filtrando um setor)
  // ou "global" (Admin sem filtro) — chaves diferentes nunca compartilham cache entre si.
  escopoSetorId: string | null;
}

function montarChaveCache({ relatorio, dateFrom, dateTo, escopoSetorId }: ChaveCacheRelatorio): string {
  return `relatorio:${relatorio}:${dateFrom}:${dateTo}:${escopoSetorId ?? "global"}`;
}

// Combinação relatório + período + escopo → cache por até 15 min. Em cache hit, `calcular`
// nunca é chamado (nenhuma query SQL adicional é executada).
export async function obterOuCalcularRelatorio<T>(
  chave: ChaveCacheRelatorio,
  calcular: () => Promise<T>
): Promise<ResultadoCache<T>> {
  const chaveRedis = montarChaveCache(chave);
  const cacheado = await redis.get(chaveRedis);
  if (cacheado !== null) {
    return { valor: JSON.parse(cacheado) as T, origem: "cache" };
  }
  const valor = await calcular();
  await redis.set(chaveRedis, JSON.stringify(valor), "EX", TTL_SEGUNDOS);
  return { valor, origem: "calculado" };
}

// Utilitário só para testes de integração — garante um estado limpo antes de medir
// hit/miss, sem depender de esperar o TTL expirar.
export async function limparCacheRelatorios(): Promise<void> {
  const chaves = await redis.keys("relatorio:*");
  if (chaves.length > 0) await redis.del(...chaves);
}
