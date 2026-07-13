// S9 (RF-RES-03, SDD §4.3 ReservaRecorrencia): geração das datas de uma série semanal,
// a partir da data da primeira ocorrência (a própria reserva sendo criada).

export class DataBaseInvalidaError extends Error {}

function paraDataUtc(data: string): Date {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function formatarDataIso(data: Date): string {
  return data.toISOString().slice(0, 10);
}

export function diaSemanaDe(data: string): number {
  return paraDataUtc(data).getUTCDay();
}

// Gera `quantidade` datas semanais (mesma hora do dia, 7 em 7 dias) a partir de
// `dataBase`, que é sempre a primeira ocorrência da série. `diaSemana` (0-6) é
// conferido apenas como validação defensiva — a rota sempre o deriva da própria
// dataBase antes de chamar esta função, então nunca deveria divergir na prática.
export function gerarDatasRecorrencia(dataBase: string, diaSemana: number, quantidade: number): string[] {
  const base = paraDataUtc(dataBase);
  if (base.getUTCDay() !== diaSemana) {
    throw new DataBaseInvalidaError(
      `A data-base ${dataBase} não corresponde ao dia da semana informado (${diaSemana}).`
    );
  }
  if (quantidade < 2 || quantidade > 12) {
    throw new RangeError("quantidade_ocorrencias deve estar entre 2 e 12.");
  }

  return Array.from({ length: quantidade }, (_, indice) => {
    const data = new Date(base);
    data.setUTCDate(base.getUTCDate() + indice * 7);
    return formatarDataIso(data);
  });
}
