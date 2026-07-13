import { createHash, randomBytes } from "node:crypto";
import { getPool, sql } from "../db/pool.js";

// Token de dispositivo do Painel TV (SDD §12): 32 bytes aleatórios, exibido em texto
// puro ao Admin apenas no momento da criação. Só o hash SHA-256 é persistido — mesmo
// padrão de "segredo mostrado uma vez" de uma API key, adequado a um token de longa
// duração que nunca deveria trafegar em texto puro fora dessa exibição inicial.
export function gerarTokenDispositivo(): string {
  return randomBytes(32).toString("hex");
}

export function hashTokenDispositivo(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface PainelTokenValido {
  id: string;
  setorId: string | null;
}

export async function validarTokenDispositivo(token: string): Promise<PainelTokenValido | null> {
  const pool = await getPool();
  const hash = hashTokenDispositivo(token);
  const result = await pool
    .request()
    .input("token_hash", sql.Char(64), hash)
    .query<{ id: string; setor_id: string | null }>(
      "SELECT id, setor_id FROM PainelToken WHERE token_hash = @token_hash AND ativo = 1"
    );
  const row = result.recordset[0];
  if (!row) {
    return null;
  }
  // Best-effort — a leitura do painel não deve falhar se este UPDATE falhar.
  void pool
    .request()
    .input("id", sql.UniqueIdentifier, row.id)
    .query("UPDATE PainelToken SET ultimo_uso_em = SYSUTCDATETIME() WHERE id = @id")
    .catch(() => {});
  return { id: row.id, setorId: row.setor_id };
}
