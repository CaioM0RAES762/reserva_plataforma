import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Rede de segurança GLOBAL (vitest.config → setupFiles): nenhum teste grava na pasta real de
// uploads do projeto. Cada arquivo de teste usa uma pasta temporária própria, apagada no fim.
const raizDeTeste = join(tmpdir(), `plataformares-storage-teste-${randomUUID()}`);
process.env.STORAGE_ROOT = raizDeTeste;

afterAll(async () => {
  await rm(raizDeTeste, { recursive: true, force: true });
});
