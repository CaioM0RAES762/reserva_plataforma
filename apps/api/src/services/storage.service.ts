import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, constants, mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { assinarComSegredo } from "../utils/jwt.js";

/* Armazenamento de arquivos enviados (imagens de plataforma, anexos de reserva, imagens de
 * comentário/não conformidade, fotos de checklist) em PASTA LOCAL do servidor.
 *
 * - Raiz: STORAGE_ROOT (padrão "./storage"). Caminho relativo é resolvido a partir da RAIZ DO
 *   PROJETO (pasta com pnpm-workspace.yaml), não do diretório de onde o processo foi iniciado —
 *   funciona igual em `pnpm dev`, `node dist/server.js` ou serviço do Windows.
 * - Banco guarda só a CHAVE relativa ("plataformas/<id>/<uuid>.jpg"); o caminho físico é sempre
 *   raiz + chave, resolvido aqui. Trocar a pasta física não exige mexer no banco.
 * - Nenhum outro módulo toca o filesystem de uploads: rotas usam só este serviço.
 * - Leitura pelo navegador: URL da própria API, assinada e com validade curta (urlDeLeitura),
 *   servida por GET /api/v1/arquivos/* (routes/arquivos.ts). */

const LIMITE_BYTES = 10 * 1024 * 1024; // RNF-09/RF-RES-14: 10 MB por arquivo.
const VALIDADE_URL_S = 60 * 60; // RNF-09: URL de leitura expira em no máximo 1 hora.
// Janela de assinatura: a URL fica estável por 30 min (o navegador reaproveita o cache entre
// recarregamentos) e vale entre 30 e 60 min a partir da emissão.
const JANELA_URL_S = 30 * 60;
export const PREFIXO_URL_ARQUIVOS = "/api/v1/arquivos/";

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

export class FormatoImagemNaoPermitidoError extends Error {
  constructor(permitidos: readonly string[]) {
    const nomes = permitidos.map((m) => m.replace("image/", "").toUpperCase()).join(", ");
    super(`Formato de imagem não permitido. Use ${nomes}.`);
    this.name = "FormatoImagemNaoPermitidoError";
  }
}

// Chave malformada ou que escaparia da raiz (../, caminho absoluto, unidade C:, barra
// invertida, byte nulo). Nunca chega ao filesystem.
export class ChaveArquivoInvalidaError extends Error {
  constructor() {
    super("Identificador de arquivo inválido.");
    this.name = "ChaveArquivoInvalidaError";
  }
}

export class ArquivoNaoEncontradoError extends Error {
  constructor() {
    super("Arquivo não encontrado.");
    this.name = "ArquivoNaoEncontradoError";
  }
}

// Falha do disco (sem espaço, sem permissão, volume somente leitura). A mensagem vai para o
// cliente, então não leva caminho físico; o detalhe técnico fica no log do servidor.
export class ArmazenamentoIndisponivelError extends Error {
  constructor() {
    super("Não foi possível gravar o arquivo no servidor. Tente novamente ou avise o administrador.");
    this.name = "ArmazenamentoIndisponivelError";
  }
}

// SDD §12: "verificação de tipo real (magic bytes) antes de gravar" — nunca confia na extensão
// do nome do arquivo nem no Content-Type/prefixo declarado. WEBP tem cabeçalho RIFF genérico
// com a tag "WEBP" no offset 8.
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

const EXTENSAO_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

// ---------------------------------------------------------------------------------------
// Raiz e chaves
// ---------------------------------------------------------------------------------------

function raizDoProjeto(): string {
  // Sobe a partir deste arquivo (src/services ou dist/services) até achar o workspace.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const pai = dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
  return process.cwd();
}

let raizEmCache: { configurada: string | undefined; caminho: string } | null = null;

/** Pasta física raiz dos uploads (lida do ambiente a cada uso — testes podem trocá-la). */
export function raizDoArmazenamento(): string {
  const configurada = process.env.STORAGE_ROOT?.trim() || undefined;
  if (raizEmCache && raizEmCache.configurada === configurada) return raizEmCache.caminho;
  const valor = configurada ?? "./storage";
  const caminho = isAbsolute(valor) ? resolve(valor) : resolve(raizDoProjeto(), valor);
  raizEmCache = { configurada, caminho };
  return caminho;
}

// Segmento aceito: letras, dígitos e . _ - ( ) espaço, sem começar por ponto. Cobre as chaves
// novas (uuid.ext) e as legadas (uuid-nome original.png).
const SEGMENTO_VALIDO = /^[A-Za-z0-9_(][A-Za-z0-9._() -]{0,199}$/;

/** Valida uma chave relativa e devolve o caminho físico, garantidamente DENTRO da raiz. */
function caminhoFisico(chave: string): string {
  if (typeof chave !== "string" || chave.length === 0 || chave.length > 500) throw new ChaveArquivoInvalidaError();
  const segmentos = chave.split("/");
  if (segmentos.some((s) => !SEGMENTO_VALIDO.test(s) || s.trim() !== s)) throw new ChaveArquivoInvalidaError();
  const raiz = raizDoArmazenamento();
  const destino = resolve(raiz, ...segmentos);
  const rel = relative(raiz, destino);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === "..") throw new ChaveArquivoInvalidaError();
  return destino;
}

/** Aceita a chave? (sem tocar o disco) — usado pela rota de leitura antes de qualquer I/O. */
export function chaveValida(chave: string): boolean {
  try {
    caminhoFisico(chave);
    return true;
  } catch {
    return false;
  }
}

function errnoDe(erro: unknown): string | undefined {
  return (erro as NodeJS.ErrnoException | undefined)?.code;
}

function logarFalhaDeDisco(operacao: string, chave: string, erro: unknown): void {
  // Chave relativa + código do erro bastam para diagnosticar; sem caminho absoluto no log.
  console.error(`[STORAGE] falha ao ${operacao} chave="${chave}" codigo=${errnoDe(erro) ?? "?"}`);
}

// ---------------------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------------------

export interface ArquivoSalvo {
  // CHAVE relativa (o que o banco guarda) — nunca um caminho físico nem URL.
  url: string;
}

export interface ArquivoSalvoDetalhado extends ArquivoSalvo {
  tipoMimeReal: string;
  tamanhoBytes: number;
}

export interface ArquivoLido {
  conteudo: Readable;
  tipoMime: string;
  tamanhoBytes: number;
}

export interface ArmazenamentoService {
  /** Valida tamanho e tipo REAL e grava em `<pasta>/<uuid>.<ext>` (nome do usuário nunca vira nome físico). */
  salvarArquivo(pasta: string, buffer: Buffer, tipoMimeDeclarado: string): Promise<ArquivoSalvoDetalhado>;
  salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo>;
  lerArquivo(chave: string): Promise<ArquivoLido>;
  existeArquivo(chave: string): Promise<boolean>;
  /** Remove o arquivo; ausente não é erro (remoção idempotente). */
  excluirArquivo(chave: string): Promise<void>;
}

function extrairDadosDataUrl(dataUrlBase64: string): { mimeDeclarado: string; buffer: Buffer } {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(dataUrlBase64);
  if (!match) {
    throw new Error("Formato de imagem inválido — esperado data URL base64 (data:.../...;base64,...).");
  }
  const [, mimeDeclarado, conteudo] = match;
  return { mimeDeclarado, buffer: Buffer.from(conteudo, "base64") };
}

const MIME_PERMITIDOS = new Set(Object.keys(EXTENSAO_POR_MIME));

class ArmazenamentoLocalService implements ArmazenamentoService {
  async salvarArquivo(pasta: string, buffer: Buffer, tipoMimeDeclarado: string): Promise<ArquivoSalvoDetalhado> {
    if (buffer.byteLength === 0 || buffer.byteLength > LIMITE_BYTES) {
      throw new ArquivoExcedeLimiteError();
    }
    const mimeReal = detectarMimeReal(buffer);
    if (!mimeReal || !MIME_PERMITIDOS.has(mimeReal)) {
      throw new MimeNaoPermitidoError(tipoMimeDeclarado, mimeReal);
    }

    const chave = `${pasta}/${randomUUID()}.${EXTENSAO_POR_MIME[mimeReal]}`;
    const destino = caminhoFisico(chave);
    // Grava num temporário e renomeia: um arquivo nunca aparece pela metade na chave final.
    const temporario = join(dirname(destino), `.${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(temporario, buffer, { flag: "wx" });
      await rename(temporario, destino);
    } catch (erro) {
      await rm(temporario, { force: true }).catch(() => undefined);
      logarFalhaDeDisco("gravar", chave, erro);
      throw new ArmazenamentoIndisponivelError();
    }
    return { url: chave, tipoMimeReal: mimeReal, tamanhoBytes: buffer.byteLength };
  }

  async salvarFotoBase64(pasta: string, dataUrlBase64: string): Promise<ArquivoSalvo> {
    const { mimeDeclarado, buffer } = extrairDadosDataUrl(dataUrlBase64);
    const salvo = await this.salvarArquivo(pasta, buffer, mimeDeclarado);
    return { url: salvo.url };
  }

  async lerArquivo(chave: string): Promise<ArquivoLido> {
    const caminho = caminhoFisico(chave);
    let tamanhoBytes: number;
    const cabecalho = Buffer.alloc(16);
    try {
      const info = await stat(caminho);
      if (!info.isFile()) throw new ArquivoNaoEncontradoError();
      tamanhoBytes = info.size;
      // Tipo pelo CONTEÚDO (como no upload), não pela extensão — vale também para chaves
      // antigas sem extensão.
      const arquivo = await open(caminho, "r");
      try {
        await arquivo.read(cabecalho, 0, cabecalho.length, 0);
      } finally {
        await arquivo.close();
      }
    } catch (erro) {
      if (erro instanceof ArquivoNaoEncontradoError || errnoDe(erro) === "ENOENT" || errnoDe(erro) === "ENOTDIR") {
        throw new ArquivoNaoEncontradoError();
      }
      logarFalhaDeDisco("ler", chave, erro);
      throw erro;
    }
    return {
      conteudo: createReadStream(caminho),
      tipoMime: detectarMimeReal(cabecalho) ?? "application/octet-stream",
      tamanhoBytes,
    };
  }

  async existeArquivo(chave: string): Promise<boolean> {
    try {
      return (await stat(caminhoFisico(chave))).isFile();
    } catch {
      return false;
    }
  }

  async excluirArquivo(chave: string): Promise<void> {
    try {
      await unlink(caminhoFisico(chave));
    } catch (erro) {
      if (errnoDe(erro) === "ENOENT") return;
      logarFalhaDeDisco("excluir", chave, erro);
      throw erro;
    }
  }
}

export const armazenamentoService: ArmazenamentoService = new ArmazenamentoLocalService();

// Validação de imagem com lista RESTRITA de formatos (ex.: fotos de plataforma: JPG/PNG/WEBP),
// antes de qualquer gravação. Tipo real pelos magic bytes; tamanho pelo mesmo limite de 10 MB.
export function validarImagemDataUrl(
  dataUrlBase64: string,
  mimesPermitidos: readonly string[]
): { buffer: Buffer; mimeReal: string } {
  const { buffer } = extrairDadosDataUrl(dataUrlBase64);
  if (buffer.byteLength === 0 || buffer.byteLength > LIMITE_BYTES) {
    throw new ArquivoExcedeLimiteError();
  }
  const mimeReal = detectarMimeReal(buffer);
  if (!mimeReal || !mimesPermitidos.includes(mimeReal)) {
    throw new FormatoImagemNaoPermitidoError(mimesPermitidos);
  }
  return { buffer, mimeReal };
}

// ---------------------------------------------------------------------------------------
// URL de leitura assinada
// ---------------------------------------------------------------------------------------

function assinatura(chave: string, expiraEm: number): string {
  return assinarComSegredo("arquivos", `${chave}\n${expiraEm}`);
}

/** URL relativa da própria aplicação para o navegador ler o arquivo (o web a encaminha à API).
 *  Assinada e com validade curta — quem recebe a URL já passou pela autorização da listagem.
 *  Chave ausente → null (a UI mostra "Sem imagem"). */
export function urlDeLeitura(chave: string | null | undefined, agoraMs = Date.now()): string | null {
  if (!chave) return null;
  const agora = Math.floor(agoraMs / 1000);
  const expiraEm = Math.floor(agora / JANELA_URL_S) * JANELA_URL_S + VALIDADE_URL_S;
  const caminho = chave.split("/").map(encodeURIComponent).join("/");
  return `${PREFIXO_URL_ARQUIVOS}${caminho}?exp=${expiraEm}&sig=${assinatura(chave, expiraEm)}`;
}

/** Confere assinatura e validade de uma URL emitida por urlDeLeitura. Devolve os segundos de
 *  validade restantes (para o Cache-Control) ou null se inválida/expirada. */
export function validarUrlDeLeitura(chave: string, exp: unknown, sig: unknown, agoraMs = Date.now()): number | null {
  const expiraEm = Number(exp);
  if (!Number.isInteger(expiraEm) || typeof sig !== "string") return null;
  const restante = expiraEm - Math.floor(agoraMs / 1000);
  if (restante <= 0 || restante > VALIDADE_URL_S) return null;
  const esperada = Buffer.from(assinatura(chave, expiraEm));
  const recebida = Buffer.from(sig);
  if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) return null;
  return restante;
}

/** Boot: cria a raiz se não existir e confere permissão de escrita. Nunca derruba a API. */
export async function prepararArmazenamento(): Promise<{ ok: true; raiz: string } | { ok: false; raiz: string; detalhe: string }> {
  const raiz = raizDoArmazenamento();
  try {
    await mkdir(raiz, { recursive: true });
    await access(raiz, constants.R_OK | constants.W_OK);
    return { ok: true, raiz };
  } catch (erro) {
    return { ok: false, raiz, detalhe: errnoDe(erro) ?? String(erro) };
  }
}
