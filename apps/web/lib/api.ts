const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3334";

export interface ApiError {
  erro: string;
  detalhes?: unknown;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const erro = (body as ApiError).erro ?? "Erro inesperado.";
    throw new Error(erro);
  }

  return body as T;
}
