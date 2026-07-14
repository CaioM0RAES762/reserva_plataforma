// Sprint S14 — prepara fixtures de teste E2E no banco de desenvolvimento já existente
// (não recria o schema, só garante senha conhecida para os perfis de teste e uma
// plataforma de baixo risco disponível para os fluxos de aprovação simples).
import sql from "mssql";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../api/.env") });

export const E2E_SENHA = "TesteE2E123!";

const pool = await sql.connect({
  server: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: process.env.DB_ENCRYPT === "true", trustServerCertificate: true },
});

const hash = await bcrypt.hash(E2E_SENHA, 12);

const contas = [
  "gestor.ti@metalsider.com.br",
  "colaborador.ti@metalsider.com.br",
];

for (const email of contas) {
  const r = await pool
    .request()
    .input("email", sql.NVarChar, email)
    .input("hash", sql.VarChar, hash)
    .query(
      "UPDATE Usuario SET senha_hash = @hash, email_verificado = 1, ativo = 1 WHERE email = @email"
    );
  console.log(`senha_hash atualizado para ${email} (linhas afetadas: ${r.rowsAffected[0]})`);
}

// Plataforma de baixo risco/sem checklist, dedicada aos fluxos de aprovação simples
// (UC-01 sem dupla aprovação, UC-05 bloqueio de agenda) — não reaproveita PLT-S8-DEMO
// (risco alto, usada nos fluxos de dupla aprovação/checklist) para não colidir agenda.
const existente = await pool
  .request()
  .input("codigo", sql.VarChar, "PLT-E2E-SALA")
  .query("SELECT id FROM Plataforma WHERE codigo = @codigo");

if (existente.recordset.length === 0) {
  await pool
    .request()
    .input("codigo", sql.VarChar, "PLT-E2E-SALA")
    .input("nome", sql.NVarChar, "Sala de Reuniões E2E (S14)")
    .input("localizacao", sql.NVarChar, "Bloco Administrativo — 2º andar")
    .input("capacidade", sql.Int, 10)
    .query(`
      INSERT INTO Plataforma (codigo, nome, localizacao, capacidade, status, categoria, risco, aprovacao_automatica)
      VALUES (@codigo, @nome, @localizacao, @capacidade, 'disponivel', 'sala', 'baixo', 0)
    `);
  console.log("Plataforma PLT-E2E-SALA criada.");
} else {
  await pool
    .request()
    .input("codigo", sql.VarChar, "PLT-E2E-SALA")
    .query("UPDATE Plataforma SET status = 'disponivel' WHERE codigo = @codigo");
  console.log("Plataforma PLT-E2E-SALA já existia — status normalizado para disponivel.");
}

// Garante que PLT-S8-DEMO (elevatória, risco alto — usada em UC-02/03/04) está disponível.
await pool.request().query(
  "UPDATE Plataforma SET status = 'disponivel' WHERE codigo = 'PLT-S8-DEMO' AND status = 'manutencao'"
);

await pool.close();
console.log("Seed E2E concluído.");
