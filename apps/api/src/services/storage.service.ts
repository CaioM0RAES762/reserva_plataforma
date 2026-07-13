import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fora de src/ para não ser varrido pelo tsc/vitest; equivalente a um container de Blob
// local só para dev/teste.
const UPLOADS_DIR = join(__dirname, "..", "..", "uploads");

export interface ArquivoSalvo {
  url: string;
}

// Interface estável para o restante do app — só a implementação muda quando o Azure
// Blob Storage entra em S11 (SDD §3.1/RF-CHK-04). Nenhum código fora deste arquivo deve
// depender de detalhes de armazenamento em disco.
export interface ArmazenamentoService {
  salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo>;
}

const MIME_PARA_EXTENSAO: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extrairDadosDataUrl(dataUrlBase64: string): { mime: string; buffer: Buffer } {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrlBase64);
  if (!match) {
    throw new Error("Formato de imagem inválido — esperado data URL base64 (data:image/...;base64,...).");
  }
  const [, mime, conteudo] = match;
  return { mime, buffer: Buffer.from(conteudo, "base64") };
}

// S8 — armazenamento simplificado em disco local, isolado atrás de ArmazenamentoService
// (ver ADR no relatório da sprint). Nunca referenciado fora deste módulo/rotas de leitura
// dos arquivos — trocar por Azure Blob Storage em S11 não deve exigir mudanças em
// checklist.service.ts nem nas rotas que chamam salvarFotoBase64.
class ArmazenamentoLocalService implements ArmazenamentoService {
  async salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo> {
    const { mime, buffer } = extrairDadosDataUrl(dataUrlBase64);
    const extensao = MIME_PARA_EXTENSAO[mime];
    if (!extensao) {
      throw new Error(`Tipo de imagem não suportado: ${mime}`);
    }
    if (buffer.byteLength > 10 * 1024 * 1024) {
      throw new Error("Arquivo excede o limite de 10 MB (RNF-09).");
    }

    const destino = join(UPLOADS_DIR, pasta);
    await mkdir(destino, { recursive: true });
    const nomeArquivo = `${randomUUID()}.${extensao}`;
    await writeFile(join(destino, nomeArquivo), buffer);

    return { url: `/uploads/${pasta}/${nomeArquivo}` };
  }
}

export const armazenamentoService: ArmazenamentoService = new ArmazenamentoLocalService();
export const UPLOADS_DIR_ABSOLUTO = UPLOADS_DIR;
