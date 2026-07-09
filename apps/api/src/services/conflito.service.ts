export interface ReservaExistente {
  id: string;
  horaInicio: string;
  horaFim: string;
}

export interface NovoHorario {
  horaInicio: string;
  horaFim: string;
  ignorarReservaId?: string;
}

function horaParaMinutos(hora: string): number {
  const [horas, minutos] = hora.split(":").map(Number);
  return horas * 60 + minutos;
}

export function horarioValido(horaInicio: string, horaFim: string): boolean {
  return horaParaMinutos(horaFim) > horaParaMinutos(horaInicio);
}

// RN-RES-02: NOT (fim_nova <= inicio_existente OR inicio_nova >= fim_existente).
// Adjacência exata (fim_nova == inicio_existente, ou inicio_nova == fim_existente) NÃO é conflito.
export function encontrarConflito(
  reservasExistentes: ReservaExistente[],
  novoHorario: NovoHorario
): ReservaExistente | null {
  const inicioNovo = horaParaMinutos(novoHorario.horaInicio);
  const fimNovo = horaParaMinutos(novoHorario.horaFim);

  const conflito = reservasExistentes.find((reserva) => {
    if (novoHorario.ignorarReservaId && reserva.id === novoHorario.ignorarReservaId) {
      return false;
    }
    const inicioExistente = horaParaMinutos(reserva.horaInicio);
    const fimExistente = horaParaMinutos(reserva.horaFim);
    return !(fimNovo <= inicioExistente || inicioNovo >= fimExistente);
  });

  return conflito ?? null;
}
