import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Roda como pré-requisito de `dev`/`dev:api` (mesmo padrão de check-port-free.mjs). Existe
// porque o erro "connect ECONNREFUSED 127.0.0.1:10000" em qualquer upload de imagem
// (comentário, não conformidade, checklist, plataforma) tem sempre a mesma causa: a API está
// configurada (AZURE_STORAGE_CONNECTION_STRING) para falar com o emulador Azurite do Azure
// Blob Storage em 127.0.0.1:10000, mas o processo do Azurite precisa estar rodando à parte —
// ninguém sobe isso automaticamente hoje, é um passo manual fácil de esquecer. Comentário sem
// imagem nunca chama o Blob Storage, por isso "funciona" mesmo com o Azurite parado; qualquer
// caminho que precise gravar/ler um arquivo falha.
//
// Este script não é o storage.service.ts nem muda nada nele — só garante que o processo local
// que ele espera encontrar em 127.0.0.1:10000 esteja de pé antes da API subir.

const PORTA = 10000;
const DIRETORIO_DADOS = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "api", ".azurite");

function portaResponde(porta) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: porta });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function aguardarPorta(porta, tentativas = 30) {
  for (let i = 0; i < tentativas; i += 1) {
    if (await portaResponde(porta)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const jaRodando = await portaResponde(PORTA);
if (jaRodando) {
  console.log(`✔ Azurite (Blob Storage local) já está rodando em 127.0.0.1:${PORTA}.`);
  process.exit(0);
}

console.log(`… Azurite não estava rodando — subindo em background (dados em ${DIRETORIO_DADOS})…`);

// shell:true resolve "azurite-blob" via PATH — pnpm já injeta node_modules/.bin no PATH deste
// script (é o mesmo mecanismo que permite "tsx" ser chamado por nome no restante do comando
// `dev`). detached + unref: o processo do Azurite sobrevive a este script encerrar e continua
// rodando pelo resto da sessão de dev (mesmo ciclo de vida de um `next dev`/`tsx watch` manual
// — ver memória do projeto sobre nunca derrubar servidores de dev já em pé).
const azurite = spawn("azurite-blob", ["--silent", "--location", DIRETORIO_DADOS, "--skipApiVersionCheck"], {
  detached: true,
  stdio: "ignore",
  shell: true,
});
azurite.unref();

const subiu = await aguardarPorta(PORTA);
if (subiu) {
  console.log(`✔ Azurite pronto em 127.0.0.1:${PORTA}.`);
} else {
  console.warn(
    `⚠ Não foi possível confirmar o Azurite em 127.0.0.1:${PORTA} a tempo — a API vai subir mesmo\n` +
      `  assim, mas upload de imagem pode falhar com ECONNREFUSED até ele terminar de iniciar.\n` +
      `  Se persistir, rode manualmente: npx azurite-blob --location apps/api/.azurite`
  );
}
process.exit(0);
