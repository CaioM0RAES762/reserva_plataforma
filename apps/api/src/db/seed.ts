import "dotenv/config";
import { closePool, getPool, sql } from "./pool.js";
import { hashPassword } from "../utils/password.js";

const SETORES = [
  { nome: "TI", cor_hex: "#2563EB" },
  { nome: "Manutenção", cor_hex: "#D97706" },
  { nome: "Limpeza", cor_hex: "#16A34A" },
  { nome: "Produção", cor_hex: "#DC2626" },
  { nome: "Administrativo", cor_hex: "#7C3AED" },
  { nome: "Segurança", cor_hex: "#0E7490" },
  { nome: "RH", cor_hex: "#BE185D" },
  { nome: "Qualidade", cor_hex: "#065F46" },
];

async function seedSetores(pool: sql.ConnectionPool) {
  for (const setor of SETORES) {
    const existing = await pool
      .request()
      .input("nome", sql.NVarChar, setor.nome)
      .query("SELECT id FROM Setor WHERE nome = @nome");

    if (existing.recordset.length > 0) {
      console.log(`Setor "${setor.nome}" já existe — ignorando.`);
      continue;
    }

    await pool
      .request()
      .input("nome", sql.NVarChar, setor.nome)
      .input("cor_hex", sql.Char(7), setor.cor_hex)
      .query("INSERT INTO Setor (nome, cor_hex, ativo) VALUES (@nome, @cor_hex, 1)");
    console.log(`Setor "${setor.nome}" criado.`);
  }
}

async function seedAdmin(pool: sql.ConnectionPool) {
  const email = process.env.SEED_ADMIN_EMAIL;
  const senha = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !senha) {
    throw new Error(
      "SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD são obrigatórias (defina no .env) — senha nunca é hardcoded."
    );
  }

  const existing = await pool
    .request()
    .input("email", sql.NVarChar, email)
    .query("SELECT id FROM Usuario WHERE email = @email");

  if (existing.recordset.length > 0) {
    console.log(`Admin "${email}" já existe — ignorando.`);
    return;
  }

  const senhaHash = await hashPassword(senha);

  await pool
    .request()
    .input("nome", sql.NVarChar, "Administrador")
    .input("email", sql.NVarChar, email)
    .input("senha_hash", sql.VarChar, senhaHash)
    .input("perfil", sql.VarChar, "admin")
    .query(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       VALUES (@nome, @email, @senha_hash, @perfil, NULL, 1, 1)`
    );

  console.log(`Admin "${email}" criado com sucesso.`);
}

async function main() {
  const pool = await getPool();
  await seedSetores(pool);
  await seedAdmin(pool);
  await closePool();
  console.log("\nSeed concluído.");
}

main().catch(async (err) => {
  console.error("Falha no seed:", err);
  await closePool();
  process.exit(1);
});
