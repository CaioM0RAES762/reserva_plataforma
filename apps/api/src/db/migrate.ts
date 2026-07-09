import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { closePool, getPool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

function splitMigration(sqlContent: string): { up: string; down: string } {
  const upMarker = "-- ==UP==";
  const downMarker = "-- ==DOWN==";
  const upStart = sqlContent.indexOf(upMarker);
  const downStart = sqlContent.indexOf(downMarker);
  if (upStart === -1 || downStart === -1) {
    throw new Error("Migration sem marcadores -- ==UP== / -- ==DOWN==");
  }
  return {
    up: sqlContent.slice(upStart + upMarker.length, downStart).trim(),
    down: sqlContent.slice(downStart + downMarker.length).trim(),
  };
}

function splitBatches(script: string): string[] {
  // SQL Server usa GO como separador de lote; sem GO nas migrations, cada
  // statement (terminado por ";") já é executável isoladamente via mssql.
  return script
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run(direction: "up" | "down") {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const pool = await getPool();
  const orderedFiles = direction === "up" ? files : [...files].reverse();

  for (const file of orderedFiles) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const { up, down } = splitMigration(content);
    const script = direction === "up" ? up : down;
    console.log(`\n=== Executando ${file} [${direction}] ===`);
    const statements = splitBatches(script);
    for (const statement of statements) {
      console.log(`--- statement ---\n${statement}\n`);
      await pool.request().query(statement);
    }
    console.log(`=== ${file} [${direction}] concluída ===`);
  }
}

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Uso: tsx src/db/migrate.ts <up|down>");
  process.exit(1);
}

run(direction)
  .then(async () => {
    console.log(`\nMigração [${direction}] finalizada com sucesso.`);
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Falha na migração:", err);
    await closePool();
    process.exit(1);
  });
