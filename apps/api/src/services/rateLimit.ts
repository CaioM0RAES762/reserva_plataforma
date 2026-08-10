import "dotenv/config";
import { getRedis } from "../db/redis.js";

const redis = getRedis();

const MAX_TENTATIVAS = 5;
const JANELA_SEGUNDOS = 10 * 60;

// RF-AUTH-05 estendido: os fluxos de código de verificação (ativação de conta e
// redefinição de senha) também precisam de limite. Sem isso, um código de 6 dígitos com
// 15 min de validade pode ser tentado indefinidamente pela mesma origem — o rate limit
// do login não cobria essas rotas.
const MAX_TENTATIVAS_CODIGO = 8;
const JANELA_CODIGO_SEGUNDOS = 15 * 60;

// Solicitação de código (envio de e-mail): limita o disparo repetido para o mesmo
// endereço, que hoje enfileira um e-mail por chamada sem qualquer barreira. O teto por
// e-mail subiu de 3 para 5 porque agora existe também uma trava de concorrência de 30s por
// (usuário, tipo) em otp.service.ts — cliques duplicados/rápidos não geram mais dois
// envios reais, só um segundo request que consome cota sem enviar nada; o teto por e-mail
// pode então ser um pouco mais generoso sem abrir brecha de abuso real.
const MAX_SOLICITACOES_CODIGO = 5;
const JANELA_SOLICITACAO_SEGUNDOS = 10 * 60;

// Defesa adicional por IP nas rotas públicas de solicitação de código: sem isto, alguém
// podia varrer e-mails diferentes a partir da mesma origem sem nunca estourar o limite por
// destinatário (que é por definição só sobre UM e-mail de cada vez). Teto generoso — não é
// o controle principal (esse é por e-mail), é só o freio contra abuso em massa.
const MAX_SOLICITACOES_POR_IP = 20;
const JANELA_SOLICITACAO_IP_SEGUNDOS = 10 * 60;

export interface RateLimitResult {
  permitido: boolean;
  tentativasRestantes: number;
}

// Contador com janela fixa no Redis. O TTL é definido só na primeira tentativa da janela
// (INCR devolve 1), então a janela conta a partir do primeiro acesso, não do último.
async function contarTentativa(chave: string, max: number, janelaSegundos: number): Promise<RateLimitResult> {
  const tentativas = await redis.incr(chave);
  if (tentativas === 1) {
    await redis.expire(chave, janelaSegundos);
  }
  return {
    permitido: tentativas <= max,
    tentativasRestantes: Math.max(0, max - tentativas),
  };
}

export async function checarRateLimitLogin(email: string): Promise<RateLimitResult> {
  return contarTentativa(`ratelimit:login:${email.toLowerCase()}`, MAX_TENTATIVAS, JANELA_SEGUNDOS);
}

export async function limparRateLimitLogin(email: string): Promise<void> {
  await redis.del(`ratelimit:login:${email.toLowerCase()}`);
}

// Verificação de um código já emitido (ativar-conta / recuperar-senha/confirmar).
export async function checarRateLimitCodigo(email: string, tipo: string): Promise<RateLimitResult> {
  return contarTentativa(
    `ratelimit:codigo:${tipo}:${email.toLowerCase()}`,
    MAX_TENTATIVAS_CODIGO,
    JANELA_CODIGO_SEGUNDOS
  );
}

export async function limparRateLimitCodigo(email: string, tipo: string): Promise<void> {
  await redis.del(`ratelimit:codigo:${tipo}:${email.toLowerCase()}`);
}

// Emissão de um novo código (envio de e-mail). `tipo` separa os contadores de
// reset_senha e ativacao_conta — sem isso, solicitar os dois fluxos para o mesmo
// e-mail em sequência consumia uma cota compartilhada que não faz sentido entre
// eles (são ações e telas distintas).
export async function checarRateLimitSolicitacaoCodigo(email: string, tipo: string): Promise<RateLimitResult> {
  return contarTentativa(
    `ratelimit:solicitacao:${tipo}:${email.toLowerCase()}`,
    MAX_SOLICITACOES_CODIGO,
    JANELA_SOLICITACAO_SEGUNDOS
  );
}

// Complementa `checarRateLimitSolicitacaoCodigo`: mesmo IP, independente do e-mail
// solicitado. `ip` deve vir de `request.ip` — o Fastify não confia em X-Forwarded-For por
// padrão (Fastify({ trustProxy }) não está configurado neste app), então isto reflete o IP
// de conexão real. Se a API algum dia rodar atrás de um proxy reverso, `trustProxy`
// precisa ser habilitado em app.ts para este limite continuar por-cliente em vez de
// virar, na prática, um limite global (todo tráfego chegando com o IP do proxy).
export async function checarRateLimitSolicitacaoPorIp(ip: string): Promise<RateLimitResult> {
  return contarTentativa(`ratelimit:solicitacao-ip:${ip}`, MAX_SOLICITACOES_POR_IP, JANELA_SOLICITACAO_IP_SEGUNDOS);
}
