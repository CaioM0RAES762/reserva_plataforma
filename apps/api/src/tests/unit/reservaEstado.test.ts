/* Máquina de estados da Reserva — fluxo com aprovação (migration 0022).
 *
 * Protege as transições legais: pendente só sai por aprovar/rejeitar/cancelar; agendada
 * e em_uso seguem o caminho de uso; estados terminais não se movem.
 */

import { describe, expect, it } from "vitest";
import {
  estadoFinal,
  janelaTotalmenteVencida,
  transicionar,
  TransicaoInvalidaError,
} from "../../services/reservaEstado.service.js";

describe("transicionar — aprovação", () => {
  it("TESTE 2/3 — aprovar leva pendente a agendada", () => {
    expect(transicionar("pendente", "aprovar")).toBe("agendada");
  });

  it("rejeitar leva pendente a rejeitada", () => {
    expect(transicionar("pendente", "rejeitar")).toBe("rejeitada");
  });

  it("só pendente pode ser aprovada ou rejeitada (decisão não se repete)", () => {
    for (const status of ["agendada", "em_uso", "concluida", "cancelada", "rejeitada"] as const) {
      expect(() => transicionar(status, "aprovar")).toThrow(TransicaoInvalidaError);
      expect(() => transicionar(status, "rejeitar")).toThrow(TransicaoInvalidaError);
    }
  });

  it("pendente não entra em uso sem aprovação", () => {
    expect(() => transicionar("pendente", "iniciar_uso")).toThrow(TransicaoInvalidaError);
  });

  it("o solicitante pode desistir de uma solicitação pendente", () => {
    expect(transicionar("pendente", "cancelar")).toBe("cancelada");
  });
});

describe("transicionar — uso", () => {
  it("percorre o caminho feliz", () => {
    expect(transicionar("agendada", "iniciar_uso")).toBe("em_uso");
    expect(transicionar("em_uso", "concluir")).toBe("concluida");
  });

  it("permite cancelar antes e durante o uso", () => {
    expect(transicionar("agendada", "cancelar")).toBe("cancelada");
    expect(transicionar("em_uso", "cancelar")).toBe("cancelada");
  });

  it("rejeita transição a partir de estado terminal", () => {
    expect(() => transicionar("concluida", "iniciar_uso")).toThrow(TransicaoInvalidaError);
    expect(() => transicionar("cancelada", "concluir")).toThrow(TransicaoInvalidaError);
    expect(() => transicionar("rejeitada", "iniciar_uso")).toThrow(TransicaoInvalidaError);
  });

  it("não permite concluir uma reserva que nunca entrou em uso", () => {
    // O sincronizador tem um caminho próprio para janela vencida sem uso.
    expect(() => transicionar("agendada", "concluir")).toThrow(TransicaoInvalidaError);
  });
});

describe("estadoFinal", () => {
  it("reconhece os três estados terminais", () => {
    expect(estadoFinal("concluida")).toBe(true);
    expect(estadoFinal("cancelada")).toBe(true);
    expect(estadoFinal("rejeitada")).toBe(true);
    expect(estadoFinal("agendada")).toBe(false);
    expect(estadoFinal("em_uso")).toBe(false);
  });
});

describe("janelaTotalmenteVencida — recuperação de servidor fora do ar", () => {
  const agora = { data: "2026-08-21", hora: "11:00" };

  it("reconhece janela de dia anterior", () => {
    expect(janelaTotalmenteVencida({ data: "2026-08-20", horaFim: "23:00" }, agora)).toBe(true);
  });

  it("reconhece janela do mesmo dia já encerrada", () => {
    // O caso da especificação: reserva 08:00–10:00, sistema volta às 11:00.
    expect(janelaTotalmenteVencida({ data: "2026-08-21", horaFim: "10:00" }, agora)).toBe(true);
  });

  it("não considera vencida uma janela em curso", () => {
    expect(janelaTotalmenteVencida({ data: "2026-08-21", horaFim: "12:00" }, agora)).toBe(false);
  });

  it("não considera vencida uma janela futura", () => {
    expect(janelaTotalmenteVencida({ data: "2026-08-22", horaFim: "09:00" }, agora)).toBe(false);
  });
});
