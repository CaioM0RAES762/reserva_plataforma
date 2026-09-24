import { getPool, sql, closePool } from "../db/pool.js";
import { hashPassword } from "../utils/password.js";
const EMAIL = "teste.agd.validacao.admin@metalsider.com.br";
const acao = process.argv[2];
const pool = await getPool();
if (acao === "criar") {
  await pool.request().input("e", sql.NVarChar, EMAIL).query("DELETE FROM Usuario WHERE email = @e");
  await pool.request()
    .input("n", sql.NVarChar, "Admin de validação temporário")
    .input("e", sql.NVarChar, EMAIL)
    .input("h", sql.VarChar, await hashPassword("ValidacaoTemp123"))
    .query("INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado) VALUES (@n, @e, @h, 'admin', NULL, 1, 1)");
  console.log("admin temporário criado");
} else {
  const q = (s: string) => pool.request().input("e", sql.NVarChar, EMAIL).query(s);
  await q("DELETE FROM LogAuditoria WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = @e)");
  await q("DELETE FROM Notificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = @e)");
  await q("DELETE FROM CodigoVerificacao WHERE usuario_id IN (SELECT id FROM Usuario WHERE email = @e)");
  await q("DELETE FROM Usuario WHERE email = @e");
  const r = await q("SELECT COUNT(*) AS n FROM Usuario WHERE email = @e");
  console.log("admin temporário removido; restam:", r.recordset[0].n);
}
await closePool();
