import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import "dotenv/config";
import type { Perfil } from "@plataformares/shared";

// S6 (hardening): impede subir em produção com o segredo de desenvolvimento — o fallback
// só é aceitável fora de produção, nunca protegendo sessões reais.
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET é obrigatório em produção (NODE_ENV=production).");
}

const JWT_SECRET = process.env.JWT_SECRET ?? "changeme-dev-only";
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? "8h") as jwt.SignOptions["expiresIn"];

export interface JwtPayload {
  sub: string;
  email: string;
  perfil: Perfil;
  setorId: string | null;
}

export function assinarToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verificarToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

/** HMAC-SHA256 com chave DERIVADA do segredo da sessão para um propósito específico
 *  (ex.: "arquivos"): mesma origem de segredo, sem reutilizar a chave dos tokens de sessão. */
export function assinarComSegredo(proposito: string, conteudo: string): string {
  const chave = createHmac("sha256", JWT_SECRET).update(`proposito:${proposito}`).digest();
  return createHmac("sha256", chave).update(conteudo).digest("base64url");
}
