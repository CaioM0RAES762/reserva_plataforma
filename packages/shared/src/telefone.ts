/* Validação e formatação de telefone brasileiro.
 *
 * Vive em `shared` porque as três camadas precisam do MESMO critério: o formulário valida
 * antes de enviar, o schema zod valida na borda da API, e o seed gera dados que precisam
 * passar por ambos. Um critério duplicado seria um bug esperando acontecer — o formulário
 * aceitaria o que a API rejeita.
 *
 * O critério é deliberadamente permissivo quanto a FORMATO e estrito quanto a CONTEÚDO:
 * telefone corporativo real vem com "+55", parênteses, hífen e ramal ("(31) 3333-4455
 * ramal 221"). Uma máscara rígida tornaria metade dos números da planta inaceitáveis. O
 * que se verifica é que existe uma quantidade plausível de dígitos.
 */

/** 10 dígitos = fixo com DDD; 11 = celular com DDD; até 17 acomoda +55 e ramal. */
const MIN_DIGITOS = 10;
const MAX_DIGITOS = 17;

export const TELEFONE_TAMANHO_MAXIMO = 40;

/** Só os dígitos — descarta +, (), -, espaços e a palavra "ramal". */
export function apenasDigitosTelefone(valor: string): string {
  return valor.replace(/\D/g, "");
}

export function telefoneValido(valor: string | null | undefined): boolean {
  if (!valor) return false;
  if (valor.length > TELEFONE_TAMANHO_MAXIMO) return false;
  const digitos = apenasDigitosTelefone(valor);
  return digitos.length >= MIN_DIGITOS && digitos.length <= MAX_DIGITOS;
}

export const MENSAGEM_TELEFONE_INVALIDO =
  "Informe um telefone válido com DDD — ex.: (31) 99999-9999.";

/**
 * Formatação de exibição, aplicada só quando o número é exatamente um fixo (10) ou celular
 * (11) sem ramal. Qualquer coisa fora disso — com +55, com ramal, internacional — é
 * devolvida como o usuário digitou: reformatar às cegas destruiria informação que só quem
 * cadastrou sabe interpretar.
 */
export function formatarTelefone(valor: string | null | undefined): string {
  if (!valor) return "";
  const bruto = valor.trim();
  const digitos = apenasDigitosTelefone(bruto);
  // Se o texto tem mais do que os dígitos do número em si (ramal, "+55"), preserva-se
  // o original.
  const somenteNumero = /^[\d\s()+-]+$/.test(bruto);
  if (!somenteNumero) return bruto;

  if (digitos.length === 10) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  }
  if (digitos.length === 11) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
  }
  return bruto;
}

/** Destino de um link `tel:` — só dígitos e um eventual "+" inicial. */
export function telefoneParaLink(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const digitos = apenasDigitosTelefone(valor);
  if (digitos.length < MIN_DIGITOS) return null;
  return valor.trim().startsWith("+") ? `+${digitos}` : digitos;
}
