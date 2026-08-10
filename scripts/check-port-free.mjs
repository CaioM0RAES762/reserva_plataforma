import net from "node:net";

// Roda como pré-requisito de `dev` (ver apps/web e apps/api/package.json). Existe porque o
// bug real já apareceu mais de uma vez nesta sessão: dois `next dev`/`tsx watch` apontando
// para a MESMA pasta do app ao mesmo tempo (um terminal do VS Code + um processo que já
// estava rodando, por exemplo) corrompem o cache `.next` compartilhado — o servidor mais
// novo reescreve chunks com hash diferente do que o navegador já carregou, e toda a tela
// perde CSS/JS até o próximo reload completo, de um jeito confuso de diagnosticar.
//
// A causa não é "next dev é instável" — é "duas instâncias escrevendo no mesmo diretório".
// Next, sozinho, não recusa subir uma segunda instância: ele detecta a porta ocupada e
// silenciosamente tenta a próxima (3001, 3002...), continuando a escrever no MESMO .next.
// Esta checagem existe para interromper isso ANTES do Next subir: se a porta alvo já está
// ocupada, aborta com uma mensagem clara em vez de deixar uma segunda instância nascer.
const porta = Number(process.argv[2]);
if (!porta) {
  console.error("Uso: node check-port-free.mjs <porta>");
  process.exit(1);
}

const servidor = net.createServer();

servidor.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n✖ A porta ${porta} já está em uso — outro servidor de desenvolvimento deste projeto já está rodando.\n` +
        `  Rodar dois ao mesmo tempo corrompe o cache .next/dist compartilhado (é exatamente o bug de\n` +
        `  "CSS sumiu depois de navegar" que já aconteceu aqui).\n\n` +
        `  Antes de tentar de novo:\n` +
        `    1. Feche o terminal/processo que já está rodando este mesmo app (dev:web ou dev:api).\n` +
        `    2. Confirme que fechou de verdade: nenhuma outra aba/terminal com este comando.\n` +
        `    3. Rode o comando novamente.\n`
    );
    process.exit(1);
  }
  console.error(`Erro inesperado ao checar a porta ${porta}:`, err);
  process.exit(1);
});

servidor.once("listening", () => {
  servidor.close(() => process.exit(0));
});

servidor.listen(porta, "0.0.0.0");
