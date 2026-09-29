import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArquivoExcedeLimiteError,
  ArquivoNaoEncontradoError,
  ChaveArquivoInvalidaError,
  MimeNaoPermitidoError,
  armazenamentoService,
  chaveValida,
  detectarMimeReal,
  prepararArmazenamento,
  raizDoArmazenamento,
  urlDeLeitura,
  validarUrlDeLeitura,
} from "../../services/storage.service.js";

// PNG mínimo válido (1x1 pixel) — magic bytes reais (89 50 4E 47 0D 0A 1A 0A).
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BUFFER = Buffer.from(PNG_1X1_BASE64, "base64");
const PDF_BUFFER = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");

async function lerTudo(conteudo: NodeJS.ReadableStream): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const parte of conteudo) partes.push(Buffer.from(parte as Buffer));
  return Buffer.concat(partes);
}

describe("detectarMimeReal (SDD §12 — verificação de tipo real via magic bytes)", () => {
  it("identifica PNG pelos bytes reais", () => {
    expect(detectarMimeReal(PNG_BUFFER)).toBe("image/png");
  });

  it("identifica JPEG pelos bytes reais", () => {
    expect(detectarMimeReal(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg");
  });

  it("identifica PDF pelos bytes reais (%PDF)", () => {
    expect(detectarMimeReal(PDF_BUFFER)).toBe("application/pdf");
  });

  it("retorna null para conteúdo sem assinatura reconhecida", () => {
    expect(detectarMimeReal(Buffer.from("isto nao e uma imagem nem pdf"))).toBeNull();
  });
});

// Pasta local real (STORAGE_ROOT temporário do setup global dos testes) — sem mocks.
describe("armazenamentoService — pasta local", () => {
  it("a raiz é a pasta configurada em STORAGE_ROOT", () => {
    expect(raizDoArmazenamento()).toBe(process.env.STORAGE_ROOT);
  });

  it("rejeita conteúdo real que não é imagem/PDF, mesmo com mime declarado válido", async () => {
    const bufferFalso = Buffer.from("isto nao e uma imagem, so texto puro disfarcado de PNG");
    await expect(armazenamentoService.salvarArquivo("testes/storage", bufferFalso, "image/png")).rejects.toThrow(
      MimeNaoPermitidoError
    );
  });

  it("rejeita arquivo acima de 10 MB mesmo com conteúdo real válido", async () => {
    const cabecalhoPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bufferGrande = Buffer.concat([cabecalhoPng, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(armazenamentoService.salvarArquivo("testes/storage", bufferGrande, "image/png")).rejects.toThrow(
      ArquivoExcedeLimiteError
    );
  });

  it("grava em <raiz>/<pasta>/<uuid>.<ext>, com chave RELATIVA, e lê os mesmos bytes de volta", async () => {
    const salvo = await armazenamentoService.salvarArquivo("testes/storage", PNG_BUFFER, "image/png");
    expect(salvo.url).toMatch(/^testes\/storage\/[0-9a-f-]{36}\.png$/);
    expect(salvo.tipoMimeReal).toBe("image/png");
    const fisico = join(raizDoArmazenamento(), ...salvo.url.split("/"));
    expect((await stat(fisico)).size).toBe(PNG_BUFFER.byteLength);

    const lido = await armazenamentoService.lerArquivo(salvo.url);
    expect(lido.tipoMime).toBe("image/png");
    expect((await lerTudo(lido.conteudo)).equals(PNG_BUFFER)).toBe(true);
  });

  it("PDF é salvo com extensão .pdf e lido como application/pdf; nenhum temporário fica na pasta", async () => {
    const salvo = await armazenamentoService.salvarArquivo("testes/pdf", PDF_BUFFER, "application/pdf");
    expect(salvo.url).toMatch(/\.pdf$/);
    expect((await armazenamentoService.lerArquivo(salvo.url)).tipoMime).toBe("application/pdf");
    expect((await readdir(join(raizDoArmazenamento(), "testes", "pdf"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("excluir remove o arquivo; excluir de novo não é erro; ler depois é 'não encontrado'", async () => {
    const salvo = await armazenamentoService.salvarArquivo("testes/storage", PNG_BUFFER, "image/png");
    await armazenamentoService.excluirArquivo(salvo.url);
    expect(await armazenamentoService.existeArquivo(salvo.url)).toBe(false);
    await expect(armazenamentoService.excluirArquivo(salvo.url)).resolves.toBeUndefined();
    await expect(armazenamentoService.lerArquivo(salvo.url)).rejects.toThrow(ArquivoNaoEncontradoError);
  });

  it("chave antiga sem extensão (migrada do Azure) é lida pelo tipo real do conteúdo", async () => {
    const salvo = await armazenamentoService.salvarArquivo("testes/legado", PNG_BUFFER, "image/png");
    const semExtensao = salvo.url.replace(/\.png$/, "");
    const { rename } = await import("node:fs/promises");
    await rename(join(raizDoArmazenamento(), ...salvo.url.split("/")), join(raizDoArmazenamento(), ...semExtensao.split("/")));
    expect((await armazenamentoService.lerArquivo(semExtensao)).tipoMime).toBe("image/png");
  });
});

describe("proteção contra path traversal", () => {
  it.each([
    "../fora.png",
    "plataformas/../../fora.png",
    "plataformas/./x.png",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "plataformas\\..\\..\\x",
    "plataformas//x.png",
    ".env",
    "plataformas/.oculto",
    "plataformas/x\0.png",
    "",
  ])("chave %j é recusada antes de qualquer acesso ao disco", async (chave) => {
    expect(chaveValida(chave)).toBe(false);
    await expect(armazenamentoService.lerArquivo(chave)).rejects.toThrow(ChaveArquivoInvalidaError);
    await expect(armazenamentoService.excluirArquivo(chave)).rejects.toThrow(ChaveArquivoInvalidaError);
  });

  it("pasta maliciosa no upload também é recusada (o arquivo nunca sai da raiz)", async () => {
    await expect(armazenamentoService.salvarArquivo("../fora", PNG_BUFFER, "image/png")).rejects.toThrow(
      ChaveArquivoInvalidaError
    );
  });
});

describe("URL de leitura assinada", () => {
  const chave = "plataformas/abc/550e8400-e29b-41d4-a716-446655440000.webp";

  it("é relativa à aplicação, sem caminho físico nem file://", () => {
    const url = urlDeLeitura(chave)!;
    expect(url.startsWith(`/api/v1/arquivos/${chave}?exp=`)).toBe(true);
    expect(url).not.toContain(raizDoArmazenamento());
    expect(urlDeLeitura(null)).toBeNull();
  });

  it("vale por até 1 hora e fica estável dentro da janela (o navegador reaproveita o cache)", () => {
    const agora = Date.UTC(2026, 8, 25, 10, 5, 0);
    const url = new URL(urlDeLeitura(chave, agora)!, "http://x");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    const restante = validarUrlDeLeitura(chave, exp, sig, agora);
    expect(restante).toBeGreaterThan(0);
    expect(restante).toBeLessThanOrEqual(3600);
    expect(urlDeLeitura(chave, agora + 60_000)).toBe(urlDeLeitura(chave, agora));
    // Expirada
    expect(validarUrlDeLeitura(chave, exp, sig, agora + 3601_000)).toBeNull();
  });

  it("assinatura adulterada ou de outro arquivo é recusada", () => {
    const url = new URL(urlDeLeitura(chave)!, "http://x");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig")!;
    expect(validarUrlDeLeitura(chave, exp, sig)).not.toBeNull();
    expect(validarUrlDeLeitura("plataformas/abc/outro.webp", exp, sig)).toBeNull();
    expect(validarUrlDeLeitura(chave, exp, sig.slice(0, -2) + "xx")).toBeNull();
    expect(validarUrlDeLeitura(chave, Number(exp) + 1800, sig)).toBeNull();
    expect(validarUrlDeLeitura(chave, undefined, undefined)).toBeNull();
  });
});

describe("prepararArmazenamento (boot)", () => {
  const original = process.env.STORAGE_ROOT;
  afterEach(() => {
    process.env.STORAGE_ROOT = original;
  });

  it("cria a pasta raiz quando ela ainda não existe", async () => {
    const nova = join(original!, "raiz-inexistente", "subpasta");
    await rm(nova, { recursive: true, force: true });
    process.env.STORAGE_ROOT = nova;
    const resultado = await prepararArmazenamento();
    expect(resultado).toEqual({ ok: true, raiz: nova });
    expect((await stat(nova)).isDirectory()).toBe(true);
  });

  it("caminho relativo é resolvido a partir da raiz do projeto, não do diretório atual", async () => {
    process.env.STORAGE_ROOT = "./storage";
    // src/tests/unit → raiz do monorepo (pasta com pnpm-workspace.yaml)
    const raizDoProjeto = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    expect(raizDoArmazenamento()).toBe(join(raizDoProjeto, "storage"));
  });
});
