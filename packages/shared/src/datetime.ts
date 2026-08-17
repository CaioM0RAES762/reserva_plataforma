// A aplicação opera num único fuso (Brasil) — um offset fixo é suficiente e evita a
// complexidade/dependência de uma lib de timezone completa. America/Sao_Paulo não usa
// horário de verão desde 2019, então o offset é constante o ano inteiro.
export const OFFSET_BRASILIA_MINUTOS = -180; // UTC-3

// Constrói o instante UTC real correspondente a uma data+hora civil de Brasília.
// Ex.: "2026-08-14" + "17:45" (hora local) => 2026-08-14T20:45:00.000Z.
//
// Por que não usar `new Date("2026-08-14T17:45:00-03:00")` direto: os dois campos
// chegam separados em todo o sistema (coluna DATE + coluna TIME no banco, inputs
// separados no formulário) — combinar como string evitaria o bug de tratar um como o
// outro, mas monta a mesma dependência textual. Explícito em dois passos (monta os
// componentes, desloca pelo offset) deixa o cálculo auditável e testável isoladamente.
export function combinarDataHoraBrasilia(data: string, hora: string): Date {
  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  const comoSeFosseUtc = Date.UTC(ano, mes - 1, dia, h, m);
  // Brasília = UTC-3, ou seja, o instante UTC real é 3h DEPOIS do relógio de Brasília:
  // subtrair um offset negativo soma o valor absoluto.
  return new Date(comoSeFosseUtc - OFFSET_BRASILIA_MINUTOS * 60_000);
}

export type ResultadoValidacaoTempo = { ok: true } | { ok: false; erro: string };

// RN-RES-03: valida se `inicio` (instante UTC real, ex.: saída de combinarDataHoraBrasilia)
// respeita a antecedência mínima a partir de `agora` (também instante UTC real —
// normalmente `new Date()`). Função pura, sem acesso a banco/relógio do sistema, para
// ser 100% determinística em teste — e reaproveitável no frontend para feedback
// imediato, mantendo backend e frontend na mesma regra em vez de duas implementações
// divergentes.
export function validarAntecedenciaMinima(
  inicio: Date,
  agora: Date,
  minimoMinutos: number
): ResultadoValidacaoTempo {
  const diferencaMinutos = (inicio.getTime() - agora.getTime()) / 60_000;
  if (diferencaMinutos < minimoMinutos) {
    const horas = minimoMinutos / 60;
    const horasTexto = Number.isInteger(horas) ? String(horas) : horas.toFixed(1);
    return {
      ok: false,
      erro: `Reservas exigem antecedência mínima de ${horasTexto} hora(s).`,
    };
  }
  return { ok: true };
}
