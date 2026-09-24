import bcrypt from "bcrypt";
import { randomInt, timingSafeEqual } from "node:crypto";
import { SENHA_INICIAL_PADRAO } from "@plataformares/shared";

const SALT_ROUNDS = 12;

// Reexportado por conveniência — quem já importa hashPassword/verifyPassword deste arquivo
// (usuarios.ts) não precisa de um segundo import só para a senha inicial. O literal em si
// mora em shared/enums.ts (único ponto de verdade, backend e frontend importam de lá).
// senha_provisoria=1 (ver 0021_perfil_e_nao_conformidade.sql) força a troca no primeiro login.
export { SENHA_INICIAL_PADRAO };

export async function hashPassword(senha: string): Promise<string> {
  return bcrypt.hash(senha, SALT_ROUNDS);
}

export async function verifyPassword(senha: string, hash: string): Promise<boolean> {
  return bcrypt.compare(senha, hash);
}

// `Math.random()` não é adequado para nada com valor de segurança (código de verificação,
// placeholder de senha): é um PRNG determinístico (xorshift128+ no V8), sem garantia
// criptográfica, e seu estado interno é recuperável a partir de poucas amostras. Um código
// de 6 dígitos previsível reduz o espaço de busca efetivo do rate limit (RF-AUTH-05/08
// tentativas), que foi dimensionado assumindo distribuição uniforme real.
export function gerarCodigoVerificacao(): string {
  const codigo = randomInt(0, 1_000_000);
  return codigo.toString().padStart(6, "0");
}

export function calcularExpiracaoCodigo(agora: Date = new Date()): Date {
  return new Date(agora.getTime() + 15 * 60 * 1000);
}

export function codigoExpirado(expiraEm: Date, agora: Date = new Date()): boolean {
  return agora.getTime() > expiraEm.getTime();
}

// Comparação em tempo constante: `===` entre strings vaza, por timing, em qual posição os
// dois valores divergem. Para um código de 6 dígitos sob rate limit isso é um risco menor,
// mas é o tipo de coisa que não custa fazer certo. `timingSafeEqual` exige buffers do mesmo
// tamanho — códigos de tamanho diferente (nunca deveria acontecer, mas o dado vem do banco)
// são tratados como não-conferindo, sem lançar.
export function codigosConferem(informado: string, esperado: string): boolean {
  const bufferInformado = Buffer.from(informado);
  const bufferEsperado = Buffer.from(esperado);
  if (bufferInformado.length !== bufferEsperado.length) return false;
  return timingSafeEqual(bufferInformado, bufferEsperado);
}
