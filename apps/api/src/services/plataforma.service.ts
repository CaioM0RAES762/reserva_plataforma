export function normalizarCodigoPlataforma(codigo: string): string {
  return codigo.trim().toUpperCase();
}

export function codigoJaCadastrado(codigosExistentes: string[], novoCodigo: string): boolean {
  const normalizado = normalizarCodigoPlataforma(novoCodigo);
  return codigosExistentes.some((codigo) => normalizarCodigoPlataforma(codigo) === normalizado);
}
