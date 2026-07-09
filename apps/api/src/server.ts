import "dotenv/config";
import { buildApp } from "./app.js";
import { iniciarEmailWorker } from "./services/queue.js";

async function main() {
  const app = await buildApp();
  const port = Number(process.env.API_PORT ?? 3333);

  iniciarEmailWorker();

  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
