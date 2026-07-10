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
