import { randomUUID } from "node:crypto";
import "dotenv/config";
import {
  BlobServiceClient,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

// S11 (SDD §12/RNF-09): sem conta Azure real disponível nesta sessão (mesma lacuna já
// registrada para o Microsoft Graph desde S1 — ver email.service.ts) — aponta para o
// emulador oficial Azurite (mesmo protocolo/SDK do Azure real), não um mock. O SDK
// (@azure/storage-blob) e a geração de SAS são exatamente os que rodariam contra uma
// conta de produção; só o endpoint muda via AZURE_STORAGE_CONNECTION_STRING.
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER ?? "anexos-reserva";
const SAS_DURACAO_MS = 60 * 60 * 1000; // RNF-09: URL de leitura expira em no máximo 1 hora.
const LIMITE_BYTES = 10 * 1024 * 1024; // RNF-09/RF-RES-14: 10 MB por arquivo.

export class MimeNaoPermitidoError extends Error {
  constructor(declarado: string, real: string | null) {
    super(
      real
        ? `Tipo de arquivo não permitido: conteúdo real é "${real}" (declarado como "${declarado}"). Apenas image/* e application/pdf são aceitos.`
        : `Não foi possível identificar o tipo real do arquivo pelos primeiros bytes (declarado como "${declarado}") — upload recusado por segurança.`
    );
    this.name = "MimeNaoPermitidoError";
  }
}

export class ArquivoExcedeLimiteError extends Error {
  constructor() {
    super("Arquivo excede o limite de 10 MB (RNF-09).");
    this.name = "ArquivoExcedeLimiteError";
  }
}

// SDD §12: "verificação de tipo real (magic bytes) antes de gravar no Blob Storage" —
// nunca confia na extensão do nome do arquivo nem no Content-Type/prefixo declarado.
// Assinaturas verificadas nos primeiros bytes do buffer (offset 0), com WEBP tratado à
// parte por ter um cabeçalho RIFF genérico com a tag "WEBP" no offset 8.
const ASSINATURAS: Array<{ mime: string; bytes: number[] }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

export function detectarMimeReal(buffer: Buffer): string | null {
  for (const assinatura of ASSINATURAS) {
    if (buffer.length >= assinatura.bytes.length && assinatura.bytes.every((b, i) => buffer[i] === b)) {
      return assinatura.mime;
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const MIME_PERMITIDOS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

export interface ArquivoSalvo {
  // Chave (path) do blob dentro do container — NUNCA uma URL pública. O acesso de
  // leitura é sempre via SAS de curta duração, gerado sob demanda (gerarUrlAcesso).
  url: string;
}

export interface ArquivoSalvoDetalhado extends ArquivoSalvo {
  tipoMimeReal: string;
  tamanhoBytes: number;
}

// Interface estável para o restante do app (mesmo contrato de S8) — troca de
// implementação (disco local -> Azure Blob) não exige mudanças em checklist.ts nem nas
// novas rotas de anexos, só nesta reimplementação.
export interface ArmazenamentoService {
  salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo>;
  salvarArquivo(
    pasta: string,
    nomeArquivo: string,
    buffer: Buffer,
    tipoMimeDeclarado: string
  ): Promise<ArquivoSalvoDetalhado>;
  gerarUrlAcesso(blobPath: string): Promise<string>;
  excluirArquivo(blobPath: string): Promise<void>;
}

function extrairDadosDataUrl(dataUrlBase64: string): { mimeDeclarado: string; buffer: Buffer } {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(dataUrlBase64);
  if (!match) {
    throw new Error("Formato de imagem inválido — esperado data URL base64 (data:.../...;base64,...).");
  }
  const [, mimeDeclarado, conteudo] = match;
  return { mimeDeclarado, buffer: Buffer.from(conteudo, "base64") };
}

let blobServiceClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  if (blobServiceClient) {
    return blobServiceClient;
  }
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING não configurada (Azure Blob Storage real ou emulador Azurite local)."
    );
  }
  blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  return blobServiceClient;
}

let containerPronto: Promise<void> | null = null;

async function getContainerClient() {
  const client = getBlobServiceClient();
  const container = client.getContainerClient(CONTAINER_NAME);
  // RNF-09: container privado (sem acesso público) — todo acesso de leitura passa por
  // SAS token gerado em gerarUrlAcesso(). createIfNotExists é idempotente; cacheado por
  // processo para não bater no Blob Storage a cada upload.
  if (!containerPronto) {
    containerPronto = container.createIfNotExists().then(() => undefined);
  }
  await containerPronto;
  return container;
}

class ArmazenamentoAzureBlobService implements ArmazenamentoService {
  async salvarArquivo(
    pasta: string,
    nomeArquivo: string,
    buffer: Buffer,
    tipoMimeDeclarado: string
  ): Promise<ArquivoSalvoDetalhado> {
    if (buffer.byteLength === 0 || buffer.byteLength > LIMITE_BYTES) {
      throw new ArquivoExcedeLimiteError();
    }
    const mimeReal = detectarMimeReal(buffer);
    if (!mimeReal || !MIME_PERMITIDOS.has(mimeReal)) {
      throw new MimeNaoPermitidoError(tipoMimeDeclarado, mimeReal);
    }

    const container = await getContainerClient();
    const blobPath = `${pasta}/${randomUUID()}-${nomeArquivo}`;
    const blockBlob = container.getBlockBlobClient(blobPath);
    await blockBlob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mimeReal } });

    return { url: blobPath, tipoMimeReal: mimeReal, tamanhoBytes: buffer.byteLength };
  }

  async salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo> {
    const { mimeDeclarado, buffer } = extrairDadosDataUrl(dataUrlBase64);
    const salvo = await this.salvarArquivo(pasta, `${randomUUID()}`, buffer, mimeDeclarado);
    return { url: salvo.url };
  }

  async gerarUrlAcesso(blobPath: string): Promise<string> {
    const client = getBlobServiceClient();
    // Assinar um SAS é uma operação puramente local (HMAC sobre a chave da conta). A
    // versão anterior chamava getContainerClient(), que faz createIfNotExists() — uma ida
    // à rede por arquivo, ou seja, uma chamada ao Blob Storage por linha em toda listagem
    // de plataformas/anexos. getBlockBlobClient apenas monta a URL, sem I/O.
    const blockBlob = client.getContainerClient(CONTAINER_NAME).getBlockBlobClient(blobPath);
    const credential = client.credential;
    if (!(credential instanceof StorageSharedKeyCredential)) {
      throw new Error("Geração de SAS exige uma connection string com chave de conta (StorageSharedKeyCredential).");
    }

    const agora = new Date();
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER_NAME,
        blobName: blobPath,
        permissions: BlobSASPermissions.parse("r"),
        // Relógio ligeiramente para trás para tolerar pequena divergência entre o
        // servidor da API e o Blob Storage; expira em no máximo 1h (RNF-09).
        startsOn: new Date(agora.getTime() - 5 * 60 * 1000),
        expiresOn: new Date(agora.getTime() + SAS_DURACAO_MS),
      },
      credential
    ).toString();

    return `${blockBlob.url}?${sas}`;
  }

  async excluirArquivo(blobPath: string): Promise<void> {
    const container = await getContainerClient();
    await container.getBlockBlobClient(blobPath).deleteIfExists();
  }
}

export const armazenamentoService: ArmazenamentoService = new ArmazenamentoAzureBlobService();

// Geração de URL tolerante a falha, para uso em LISTAGENS.
//
// Motivo (bug real): `GET /api/v1/plataformas` mapeava cada linha chamando
// `gerarUrlAcesso` diretamente. Com o Blob Storage indisponível (ou a connection string
// ausente), uma única plataforma com imagem cadastrada fazia a rota inteira responder
// 500 — derrubando junto a tela de Frota, o Dashboard e o seletor de plataforma do
// formulário de reserva, todos por causa de uma miniatura. Uma imagem que não carrega
// nunca deve impedir a leitura dos dados: aqui a falha vira `null` (a UI já trata como
// "Sem imagem") e fica registrada no log do servidor.
export async function gerarUrlAcessoOuNulo(
  blobPath: string | null | undefined,
  aoFalhar?: (erro: unknown) => void
): Promise<string | null> {
  if (!blobPath) return null;
  try {
    return await armazenamentoService.gerarUrlAcesso(blobPath);
  } catch (erro) {
    aoFalhar?.(erro);
    return null;
  }
}
