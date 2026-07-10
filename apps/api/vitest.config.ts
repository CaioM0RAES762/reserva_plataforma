import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    // S7: vários arquivos de integração fazem login como o mesmo Admin seedado em
    // beforeAll. Rodar arquivos em paralelo faz suas chamadas a POST /auth/login
    // corridarem contra o mesmo contador de rate limit no Redis (5 tentativas/10min),
    // podendo estourar 429 mesmo em logins bem-sucedidos. Serializar os arquivos evita
    // essa disputa por estado compartilhado (mesmo padrão de causa raiz documentado em
    // rateLimit.ts) sem precisar mockar o rate limiter nos testes de integração.
    fileParallelism: false,
  },
});
