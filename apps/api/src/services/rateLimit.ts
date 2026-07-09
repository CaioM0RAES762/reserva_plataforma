import { Redis as IORedis } from "ioredis";
import "dotenv/config";

const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379");

const MAX_TENTATIVAS = 5;
const JANELA_SEGUNDOS = 10 * 60;

export interface RateLimitResult {
  permitido: boolean;
  tentativasRestantes: number;
}

export async function checarRateLimitLogin(email: string): Promise<RateLimitResult> {
  const chave = `ratelimit:login:${email.toLowerCase()}`;
  const tentativas = await redis.incr(chave);
  if (tentativas === 1) {
    await redis.expire(chave, JANELA_SEGUNDOS);
  }
  return {
    permitido: tentativas <= MAX_TENTATIVAS,
    tentativasRestantes: Math.max(0, MAX_TENTATIVAS - tentativas),
  };
}

export async function limparRateLimitLogin(email: string): Promise<void> {
  await redis.del(`ratelimit:login:${email.toLowerCase()}`);
}
