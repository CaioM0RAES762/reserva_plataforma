import { Redis as IORedis } from "ioredis";
import "dotenv/config";

// Cliente Redis único, reaproveitado por rate limit e pelo lock de emissão de OTP — duas
// conexões TCP redundantes para o mesmo Redis não trazem benefício nenhum aqui (o volume é
// baixo e ambos os usos são operações atômicas simples, sem contenção entre si).
let cliente: IORedis | null = null;

export function getRedis(): IORedis {
  if (!cliente) {
    cliente = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return cliente;
}
