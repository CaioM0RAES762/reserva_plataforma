import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { FastifyInstance } from "fastify";
import { autenticar } from "../middlewares/rbac.js";
import { UPLOADS_DIR_ABSOLUTO } from "../services/storage.service.js";

const CONTENT_TYPE_POR_EXTENSAO: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// S8 — leitura das evidências fotográficas do checklist (armazenamento local
// simplificado, ver storage.service.ts). Exige sessão autenticada, igual às demais
// rotas de escopo de reserva; troca para Azure Blob + SAS token entra em S11 (RNF-09).
export async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/uploads/*", { preHandler: autenticar }, async (request, reply) => {
    const caminhoRelativo = (request.params as { "*": string })["*"];
    const caminhoNormalizado = normalize(caminhoRelativo);
    if (caminhoNormalizado.startsWith("..")) {
      return reply.status(400).send({ erro: "Caminho inválido." });
    }

    const extensao = caminhoNormalizado.split(".").pop()?.toLowerCase() ?? "";
    const contentType = CONTENT_TYPE_POR_EXTENSAO[extensao];
    if (!contentType) {
      return reply.status(400).send({ erro: "Tipo de arquivo não suportado." });
    }

    try {
      const buffer = await readFile(join(UPLOADS_DIR_ABSOLUTO, caminhoNormalizado));
      return reply.status(200).header("content-type", contentType).send(buffer);
    } catch {
      return reply.status(404).send({ erro: "Arquivo não encontrado." });
    }
  });
}
