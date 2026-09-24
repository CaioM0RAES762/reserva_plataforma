// Regra "Reserva para setor Terceirizados exige a empresa": fonte única para o formulário
// (feedback imediato) e para a rota POST /reservas (autoridade). Nenhuma das duas pode
// reimplementar a comparação de nomes — divergir aqui é como o front deixaria passar o que
// o backend rejeita, ou o contrário.

export const EMPRESA_TERCEIRIZADA_MAX = 120;

/** Nome canônico do setor que dispara a regra, já normalizado (ver `normalizarNomeSetor`). */
const SETOR_TERCEIRIZADOS_NORMALIZADO = "terceirizados";

/** Minúsculas, sem acento, espaços colapsados — "  Terceirizados " e "TERCEIRIZADOS" casam. */
export function normalizarNomeSetor(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * O setor não tem uma flag própria no cadastro: a regra é identificada pelo NOME do setor
 * ("Terceirizados"), comparado sem diferenciar caixa/acento/espaços nas pontas.
 */
export function setorExigeEmpresaTerceirizada(nomeSetor: string | null | undefined): boolean {
  return normalizarNomeSetor(nomeSetor) === SETOR_TERCEIRIZADOS_NORMALIZADO;
}

/** trim + espaços internos colapsados. String vazia = "não informado". */
export function normalizarEmpresaTerceirizada(valor: string | null | undefined): string {
  return (valor ?? "").replace(/\s+/g, " ").trim();
}

export const MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA =
  "Informe o nome da empresa terceirizada.";
export const MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA = `O nome da empresa deve ter no máximo ${EMPRESA_TERCEIRIZADA_MAX} caracteres.`;

/** `null` = válido. `exigida` vem de `setorExigeEmpresaTerceirizada(setorNome)`. */
export function validarEmpresaTerceirizada(
  valor: string | null | undefined,
  exigida: boolean
): string | null {
  const normalizada = normalizarEmpresaTerceirizada(valor);
  if (normalizada.length > EMPRESA_TERCEIRIZADA_MAX) return MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA;
  if (exigida && normalizada.length === 0) return MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA;
  return null;
}
