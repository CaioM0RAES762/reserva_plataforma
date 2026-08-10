// Mascara o e-mail para exibição ("cai***@metalsider.com.br"): confirma para o
// usuário que é o endereço certo sem expor o e-mail completo numa tela que pode
// estar visível a terceiros (projetor, corredor, ombro de colega).
export function mascararEmail(email: string): string {
  const [usuario, dominio] = email.trim().toLowerCase().split("@");
  if (!usuario || !dominio) return email;
  const visiveis = usuario.slice(0, Math.min(3, usuario.length));
  const ocultos = "*".repeat(Math.max(usuario.length - visiveis.length, 3));
  return `${visiveis}${ocultos}@${dominio}`;
}
