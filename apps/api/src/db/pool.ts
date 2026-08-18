import sql from "mssql";
import "dotenv/config";

const config: sql.config = {
  server: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 1433),
  database: process.env.DB_NAME ?? "PlataformaRes",
  user: process.env.DB_USER ?? "sa",
  password: process.env.DB_PASSWORD ?? "",
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE !== "false",
  },
  // RNF-03 (50 usuários simultâneos): o padrão do driver é max 10 conexões.
  // Uma tela como o Dashboard dispara até 8 requisições em paralelo, e várias rotas
  // (KPIs, agenda) fazem 3–5 consultas concorrentes cada — com 10 conexões, requisições
  // ficavam enfileiradas esperando o pool sob carga, inflando o p95 sem que o banco
  // estivesse sequer ocupado.
  pool: {
    max: Number(process.env.DB_POOL_MAX ?? 25),
    min: Number(process.env.DB_POOL_MIN ?? 2),
    // Devolve conexões ociosas depois de 30s em vez de mantê-las abertas indefinidamente.
    idleTimeoutMillis: 30_000,
    // Falha rápido quando o pool está saturado, em vez de deixar a requisição pendurada
    // até o timeout do cliente HTTP (o erro vira 500 com log, e o usuário recebe resposta).
    acquireTimeoutMillis: 15_000,
  },
  // Sem estes limites, uma consulta travada segura a conexão para sempre.
  connectionTimeout: 15_000,
  requestTimeout: 30_000,
};

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    // Uma falha na conexão inicial deixava a promise rejeitada em cache: toda requisição
    // seguinte reusava a mesma rejeição e a API só voltava a funcionar depois de um
    // restart, mesmo com o banco já saudável. Limpando o cache no erro, a próxima
    // requisição tenta conectar de novo.
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

export { sql };
