import jwt from "jsonwebtoken";
import "dotenv/config";

const JWT_SECRET = process.env.JWT_SECRET ?? "changeme-dev-only";
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? "8h") as jwt.SignOptions["expiresIn"];

export interface JwtPayload {
  sub: string;
  email: string;
  perfil: "admin" | "colaborador";
  setorId: string | null;
}

export function assinarToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verificarToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
