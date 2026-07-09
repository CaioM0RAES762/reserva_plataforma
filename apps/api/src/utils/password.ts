import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(senha: string): Promise<string> {
  return bcrypt.hash(senha, SALT_ROUNDS);
}

export async function verifyPassword(senha: string, hash: string): Promise<boolean> {
  return bcrypt.compare(senha, hash);
}

export function gerarCodigoVerificacao(): string {
  const codigo = Math.floor(Math.random() * 1_000_000);
  return codigo.toString().padStart(6, "0");
}

export function calcularExpiracaoCodigo(agora: Date = new Date()): Date {
  return new Date(agora.getTime() + 15 * 60 * 1000);
}

export function codigoExpirado(expiraEm: Date, agora: Date = new Date()): boolean {
  return agora.getTime() > expiraEm.getTime();
}
