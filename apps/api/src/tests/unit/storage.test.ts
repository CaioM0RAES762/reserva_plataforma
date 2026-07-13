import { describe, expect, it } from "vitest";
import {
  ArquivoExcedeLimiteError,
  MimeNaoPermitidoError,
  armazenamentoService,
  detectarMimeReal,
} from "../../services/storage.service.js";

// PNG mínimo válido (1x1 pixel) — magic bytes reais (89 50 4E 47 0D 0A 1A 0A).
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BUFFER = Buffer.from(PNG_1X1_BASE64, "base64");

describe("detectarMimeReal (SDD §12 — verificação de tipo real via magic bytes)", () => {
  it("identifica PNG pelos bytes reais", () => {
    expect(detectarMimeReal(PNG_BUFFER)).toBe("image/png");
  });

  it("identifica JPEG pelos bytes reais", () => {
    expect(detectarMimeReal(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg");
  });

  it("identifica PDF pelos bytes reais (%PDF)", () => {
    expect(detectarMimeReal(Buffer.from("%PDF-1.4\n..."))).toBe("application/pdf");
  });

  it("retorna null para conteúdo sem assinatura reconhecida", () => {
    expect(detectarMimeReal(Buffer.from("isto nao e uma imagem nem pdf"))).toBeNull();
  });
});

// Estes testes exercitam o SDK real do Azure Blob Storage (@azure/storage-blob) contra o
// emulador Azurite local (sem conta Azure real disponível nesta sessão — ver ADR no
// relatório da sprint) — não são mocks: fazem upload real via HTTP e leitura real via SAS.
describe("armazenamentoService.salvarArquivo — RF-RES-14/SDD §12 (rejeição real, não mockada)", () => {
  it("rejeita arquivo cujo conteúdo real (magic bytes) não é image/* nem application/pdf, mesmo com mime declarado válido", async () => {
    const bufferFalso = Buffer.from("isto nao e uma imagem, so texto puro disfarcado de PNG");
    await expect(
      armazenamentoService.salvarArquivo("testes/storage", "fake.png", bufferFalso, "image/png")
    ).rejects.toThrow(MimeNaoPermitidoError);
  });

  it("rejeita arquivo acima de 10 MB mesmo com conteúdo real válido", async () => {
    const cabecalhoPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bufferGrande = Buffer.concat([cabecalhoPng, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(
      armazenamentoService.salvarArquivo("testes/storage", "grande.png", bufferGrande, "image/png")
    ).rejects.toThrow(ArquivoExcedeLimiteError);
  });

  it("aceita e persiste um PNG real, e o SAS gerado permite ler os mesmos bytes de volta", async () => {
    const salvo = await armazenamentoService.salvarArquivo("testes/storage", "pixel.png", PNG_BUFFER, "image/png");
    expect(salvo.tipoMimeReal).toBe("image/png");
    expect(salvo.tamanhoBytes).toBe(PNG_BUFFER.byteLength);

    const url = await armazenamentoService.gerarUrlAcesso(salvo.url);
    expect(url).toContain("sig=");
    const resposta = await fetch(url);
    expect(resposta.status).toBe(200);
    const lido = Buffer.from(await resposta.arrayBuffer());
    expect(lido.equals(PNG_BUFFER)).toBe(true);
  });
});
