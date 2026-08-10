import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRedis } from "../../db/redis.js";
import {
  checarRateLimitSolicitacaoCodigo,
  checarRateLimitSolicitacaoPorIp,
  limparRateLimitCodigo,
} from "../../services/rateLimit.js";

const EMAIL_TESTE = "teste.ratelimit.unit@metalsider.com.br";
const IP_TESTE = "203.0.113.42";

async function limparChaves(): Promise<void> {
  const redis = getRedis();
  await redis.del(`ratelimit:solicitacao:ativacao_conta:${EMAIL_TESTE}`);
  await redis.del(`ratelimit:solicitacao-ip:${IP_TESTE}`);
}

beforeEach(limparChaves);
afterAll(limparChaves);

describe("checarRateLimitSolicitacaoCodigo", () => {
  it("permite até o teto configurado e bloqueia a partir daí, na mesma janela", async () => {
    const resultados = [];
    for (let i = 0; i < 6; i++) {
      resultados.push(await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "ativacao_conta"));
    }
    // Teto atual = 5 (ver rateLimit.ts) — as 5 primeiras passam, a 6ª é bloqueada.
    expect(resultados.slice(0, 5).every((r) => r.permitido)).toBe(true);
    expect(resultados[5].permitido).toBe(false);
  });

  it("é isolado por e-mail normalizado (case-insensitive)", async () => {
    const minuscula = await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "ativacao_conta");
    const maiuscula = await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE.toUpperCase(), "ativacao_conta");
    // Mesma chave Redis (normalização por toLowerCase) — a segunda chamada soma na mesma
    // janela da primeira, não abre uma cota nova só por causa da caixa das letras.
    expect(maiuscula.tentativasRestantes).toBe(minuscula.tentativasRestantes - 1);
  });

  it("é isolado por tipo (ativacao_conta não compartilha cota com reset_senha)", async () => {
    await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "ativacao_conta");
    await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "ativacao_conta");
    const resetSenha = await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "reset_senha");
    // Se compartilhasse chave, esta seria a 3ª tentativa (tentativasRestantes menor).
    expect(resetSenha.tentativasRestantes).toBe(4);
    await getRedis().del(`ratelimit:solicitacao:reset_senha:${EMAIL_TESTE}`);
  });

  it("limparRateLimitCodigo remove o contador (fluxo: código correto zera as tentativas)", async () => {
    await checarRateLimitSolicitacaoCodigo(EMAIL_TESTE, "ativacao_conta");
    await limparRateLimitCodigo(EMAIL_TESTE, "ativacao_conta");
    const redis = getRedis();
    const valor = await redis.get(`ratelimit:codigo:ativacao_conta:${EMAIL_TESTE}`);
    expect(valor).toBeNull();
  });
});

describe("checarRateLimitSolicitacaoPorIp", () => {
  it("conta tentativas por IP independente do e-mail solicitado", async () => {
    const primeira = await checarRateLimitSolicitacaoPorIp(IP_TESTE);
    const segunda = await checarRateLimitSolicitacaoPorIp(IP_TESTE);
    expect(segunda.tentativasRestantes).toBe(primeira.tentativasRestantes - 1);
  });
});
