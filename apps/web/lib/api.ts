const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export interface ApiError {
  erro: string;
  detalhes?: unknown;
}

// Erro tipado: preserva o status HTTP e os `detalhes` do Zod para a UI decidir o
// tratamento (409 = conflito de regra de negócio, 403 = fora de escopo, 422 = campo
// inválido) em vez de só exibir uma string genérica.
export class ApiRequestError extends Error {
  readonly status: number;
  readonly detalhes?: unknown;

  constructor(mensagem: string, status: number, detalhes?: unknown) {
    super(mensagem);
    this.name = "ApiRequestError";
    this.status = status;
    this.detalhes = detalhes;
  }

  get ehConflito(): boolean {
    return this.status === 409;
  }
  get ehSemPermissao(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get ehValidacao(): boolean {
    return this.status === 422;
  }
}

const MENSAGEM_REDE =
  "Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.";

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  // O parser JSON do Fastify rejeita corpo vazio quando o Content-Type é application/json
  // (FST_ERR_CTP_EMPTY_JSON_BODY) — bug real que apareceu em S4 e voltou em S10 porque o
  // header era enviado incondicionalmente. Definindo o header só quando existe corpo, toda
  // chamada sem payload funciona sem precisar do `body: JSON.stringify({})` defensivo.
  const temCorpo = options.body !== undefined && options.body !== null;
  const headers: Record<string, string> = {
    ...(temCorpo ? { "Content-Type": "application/json" } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, credentials: "include", headers });
  } catch (err) {
    // AbortError vem de um cancelamento deliberado (troca de filtro, unmount) — propaga
    // como está para o chamador poder ignorá-lo sem exibir erro ao usuário.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(MENSAGEM_REDE, 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const { erro, detalhes } = body as ApiError;
    throw new ApiRequestError(erro ?? "Erro inesperado.", response.status, detalhes);
  }

  return body as T;
}

// Downloads (CSV/XLSX/PDF) não passam por apiFetch porque a resposta é um Blob, não JSON.
// Centralizado aqui para que toda tela use o mesmo tratamento de erro e o mesmo fluxo de
// download, em vez de repetir fetch+createObjectURL em quatro componentes diferentes.
export async function apiDownload(path: string, nomeArquivo: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { credentials: "include" });
  } catch {
    throw new ApiRequestError(MENSAGEM_REDE, 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    throw new ApiRequestError(body.erro ?? "Falha ao gerar o arquivo.", response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function mensagemDeErro(err: unknown, padrao: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return padrao;
}
