import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/* GET /api/v1/arquivos/* — única forma de o navegador ler um upload (pasta local).
 * Não depende do banco: os arquivos são gravados direto pelo serviço de armazenamento, na
 * pasta temporária do setup global dos testes. */

const { buildApp } = await import("../../app.js");
const { closePool } = await import("../../db/pool.js");
const { armazenamentoService, raizDoArmazenamento, urlDeLeitura } = await import("../../services/storage.service.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");

let app: FastifyInstance;
let chavePng: string;
let chavePdf: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  chavePng = (await armazenamentoService.salvarArquivo("plataformas/teste-leitura", PNG, "image/png")).url;
  chavePdf = (await armazenamentoService.salvarArquivo("reservas/teste-leitura", PDF, "application/pdf")).url;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("GET /api/v1/arquivos/*", () => {
  it("imagem: 200 com os mesmos bytes, Content-Type real e cache privado limitado à validade", async () => {
    const r = await get(urlDeLeitura(chavePng)!);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.rawPayload.equals(PNG)).toBe(true);
    expect(String(r.headers["cache-control"])).toMatch(/^private, max-age=\d+$/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("PDF: servido como application/pdf, inline", async () => {
    const r = await get(urlDeLeitura(chavePdf)!);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toBe("inline");
    expect(r.rawPayload.equals(PDF)).toBe(true);
  });

  it("sem assinatura, assinatura adulterada ou de outro arquivo: 403", async () => {
    expect((await get(`/api/v1/arquivos/${chavePng}`)).statusCode).toBe(403);
    const url = urlDeLeitura(chavePng)!;
    expect((await get(url.replace(/sig=.{4}/, "sig=AAAA"))).statusCode).toBe(403);
    const deOutro = urlDeLeitura(chavePdf)!.split("?")[1];
    expect((await get(`/api/v1/arquivos/${chavePng}?${deOutro}`)).statusCode).toBe(403);
  });

  it("path traversal é recusado e a resposta não expõe caminho físico", async () => {
    for (const url of [
      "/api/v1/arquivos/..%2F..%2Fapps%2Fapi%2F.env?exp=1&sig=x",
      "/api/v1/arquivos/plataformas%2F..%2F..%2F.env?exp=1&sig=x",
      "/api/v1/arquivos/C:%5CWindows%5Cwin.ini?exp=1&sig=x",
      "/api/v1/arquivos/%2Fetc%2Fpasswd?exp=1&sig=x",
    ]) {
      const r = await get(url);
      expect([400, 404]).toContain(r.statusCode);
      expect(r.body).not.toContain(raizDoArmazenamento());
    }
  });

  it("arquivo inexistente com link válido: 404 sem caminho físico", async () => {
    const r = await get(urlDeLeitura("plataformas/teste-leitura/nao-existe.png")!);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ erro: "Arquivo não encontrado." });
  });

  it("após reiniciar a API, o mesmo arquivo continua disponível", async () => {
    await app.close();
    app = await buildApp();
    await app.ready();
    const r = await get(urlDeLeitura(chavePng)!);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PNG)).toBe(true);
  });
});
