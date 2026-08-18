import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { closePool, getPool, sql } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

// Tabela de controle — pendência aberta desde S4 e reafirmada em S5/S6/S7/S9/S13.
// Sem ela, `migrate:up` reexecutava TODOS os arquivos a cada chamada e falhava no
// primeiro CREATE TABLE de algo já existente; a consequência prática é que todas as
// migrations de S4 em diante foram aplicadas à mão via sqlcmd, sem registro do que já
// tinha rodado em cada ambiente — inviável para o deploy de S15.
const TABELA_CONTROLE = "SchemaMigracao";

async function garantirTabelaControle(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = '${TABELA_CONTROLE}')
      CREATE TABLE ${TABELA_CONTROLE} (
        nome        VARCHAR(200)  NOT NULL PRIMARY KEY,
        checksum    CHAR(64)      NOT NULL,
        aplicada_em DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
      )
  `);
}

interface MigracaoAplicada {
  nome: string;
  checksum: string;
}

async function listarAplicadas(): Promise<Map<string, string>> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<MigracaoAplicada>(`SELECT nome, checksum FROM ${TABELA_CONTROLE}`);
  return new Map(result.recordset.map((linha) => [linha.nome, linha.checksum]));
}

function listarArquivos(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((arquivo) => arquivo.endsWith(".sql"))
    .sort();
}

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

// SQL Server usa GO como separador de LOTE (não é um comando T-SQL — é uma instrução para
// o cliente). Migrations de S7/S9 dependem dele: um ALTER TABLE que adiciona uma coluna e
// um CHECK que a referencia precisam estar em lotes distintos, senão o T-SQL falha com
// "Invalid column name" ao resolver os nomes do lote inteiro de uma vez.
//
// O runner anterior só separava por ";" — as linhas `GO` eram enviadas ao servidor como se
// fossem SQL, o que faz o driver lançar erro de sintaxe. Por isso toda migration com GO
// (0004, 0005, 0007) teve de ser aplicada manualmente por fora.
function splitBatches(script: string): string[] {
  const semComentariosDeLinha = script;
  const lotes = semComentariosDeLinha.split(/^\s*GO\s*;?\s*$/gim);

  return lotes
    .flatMap((lote) => {
      const conteudo = lote.trim();
      if (!conteudo) return [];
      // Dentro de um lote, cada statement terminado por ";" é executável isoladamente.
      // Statements que precisam de escopo de lote próprio já foram separados por GO acima.
      return conteudo
        .split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    })
    .filter(apenasComentarios);
}

// Descarta pedaços que só contêm comentário (nada a executar). A versão anterior testava
// `/^(--[^\n]*\s*)+$/`, que sofre backtracking catastrófico: numa linha separadora
// (`-- -----------------`), o `--` do grupo repetido casa em dezenas de posições dentro da
// própria sequência de hífens, e o motor tenta todas as partições antes de desistir — uma
// migration com esse tipo de separador travava o `migrate:up` indefinidamente, sem erro nem
// log. Verificar linha a linha custa tempo linear e expressa a mesma intenção.
function apenasComentarios(statement: string): boolean {
  return statement
    .split(/\r?\n/)
    .some((linha) => {
      const conteudo = linha.trim();
      return conteudo.length > 0 && !conteudo.startsWith("--");
    });
}

function checksumDe(conteudo: string): string {
  return createHash("sha256").update(conteudo, "utf8").digest("hex");
}

async function executarScript(script: string, rotulo: string): Promise<void> {
  const pool = await getPool();
  const statements = splitBatches(script);
  // Cada migration é atômica: se um statement falha no meio, nada dela fica aplicado —
  // antes, uma migration com 5 statements podia deixar o banco no estado intermediário
  // dos 2 primeiros, sem registro nenhum disso.
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (const statement of statements) {
      await transaction.request().batch(statement);
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    throw new Error(`Falha ao aplicar ${rotulo}: ${(err as Error).message}`, { cause: err });
  }
}

async function registrarAplicada(nome: string, checksum: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("nome", sql.VarChar, nome)
    .input("checksum", sql.Char(64), checksum)
    .query(`INSERT INTO ${TABELA_CONTROLE} (nome, checksum) VALUES (@nome, @checksum)`);
}

async function removerRegistro(nome: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input("nome", sql.VarChar, nome)
    .query(`DELETE FROM ${TABELA_CONTROLE} WHERE nome = @nome`);
}

async function up(): Promise<void> {
  await garantirTabelaControle();
  const aplicadas = await listarAplicadas();
  const arquivos = listarArquivos();
  let executadas = 0;

  for (const arquivo of arquivos) {
    const conteudo = readFileSync(join(MIGRATIONS_DIR, arquivo), "utf-8");
    const checksum = checksumDe(conteudo);
    const checksumAplicado = aplicadas.get(arquivo);

    if (checksumAplicado) {
      // Migration já aplicada que teve o arquivo editado depois: avisa em vez de
      // reexecutar (o banco não corresponde mais ao que está no repositório).
      if (checksumAplicado !== checksum) {
        console.warn(
          `[aviso] ${arquivo} já foi aplicada, mas o arquivo mudou desde então. ` +
            `Crie uma migration nova em vez de editar uma já aplicada.`
        );
      }
      continue;
    }

    console.log(`=== aplicando ${arquivo} ===`);
    const { up: scriptUp } = splitMigration(conteudo);
    await executarScript(scriptUp, arquivo);
    await registrarAplicada(arquivo, checksum);
    executadas += 1;
    console.log(`=== ${arquivo} aplicada ===`);
  }

  console.log(
    executadas === 0
      ? "Nenhuma migration pendente — banco já está atualizado."
      : `${executadas} migration(s) aplicada(s).`
  );
}

// Reverte APENAS a última migration aplicada. O runner antigo executava o ==DOWN== de
// todos os arquivos de uma vez, ou seja, `migrate:down` derrubava o banco inteiro — bom
// para o teste up/down de uma sprint, catastrófico se rodado por engano num ambiente com
// dados. `down --tudo` mantém o comportamento antigo, mas agora é preciso pedi-lo.
async function down(tudo: boolean): Promise<void> {
  await garantirTabelaControle();
  const aplicadas = await listarAplicadas();
  const arquivos = listarArquivos()
    .filter((arquivo) => aplicadas.has(arquivo))
    .reverse();

  if (arquivos.length === 0) {
    console.log("Nenhuma migration aplicada para reverter.");
    return;
  }

  const alvos = tudo ? arquivos : [arquivos[0]];
  for (const arquivo of alvos) {
    console.log(`=== revertendo ${arquivo} ===`);
    const conteudo = readFileSync(join(MIGRATIONS_DIR, arquivo), "utf-8");
    const { down: scriptDown } = splitMigration(conteudo);
    await executarScript(scriptDown, `${arquivo} [down]`);
    await removerRegistro(arquivo);
    console.log(`=== ${arquivo} revertida ===`);
  }
}

// Adota um banco que já tem o schema aplicado à mão (o caso de todos os ambientes atuais,
// onde 0001–0013 foram executadas via sqlcmd): registra os arquivos como aplicados SEM
// executá-los, para que daí em diante só as migrations novas rodem.
async function baseline(ate?: string): Promise<void> {
  await garantirTabelaControle();
  const aplicadas = await listarAplicadas();
  const arquivos = listarArquivos().filter((arquivo) => !ate || arquivo <= ate);
  let registradas = 0;

  for (const arquivo of arquivos) {
    if (aplicadas.has(arquivo)) continue;
    const conteudo = readFileSync(join(MIGRATIONS_DIR, arquivo), "utf-8");
    await registrarAplicada(arquivo, checksumDe(conteudo));
    registradas += 1;
    console.log(`registrada como já aplicada (sem executar): ${arquivo}`);
  }

  console.log(`Baseline concluído — ${registradas} migration(s) registrada(s).`);
}

async function status(): Promise<void> {
  await garantirTabelaControle();
  const aplicadas = await listarAplicadas();
  for (const arquivo of listarArquivos()) {
    console.log(`${aplicadas.has(arquivo) ? "[x]" : "[ ]"} ${arquivo}`);
  }
}

const comando = process.argv[2];
const argumento = process.argv[3];

async function executar(): Promise<void> {
  switch (comando) {
    case "up":
      return up();
    case "down":
      return down(argumento === "--tudo");
    case "baseline":
      return baseline(argumento);
    case "status":
      return status();
    default:
      console.error(
        "Uso: tsx src/db/migrate.ts <comando>\n" +
          "  up                  aplica as migrations pendentes\n" +
          "  down [--tudo]       reverte a última migration (ou todas com --tudo)\n" +
          "  baseline [arquivo]  marca as migrations existentes como aplicadas, sem executá-las\n" +
          "  status              lista o que já foi aplicado"
      );
      process.exit(1);
  }
}

executar()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Falha na migração:", err);
    await closePool();
    process.exit(1);
  });
