import { describe, expect, it } from "vitest";
import {
  AprovacaoJaRealizadaError,
  decidirAprovacao,
  estadoFinal,
  exigeDuplaAprovacao,
  transicionar,
  TransicaoInvalidaError,
  type AcaoReserva,
} from "../../services/aprovacao.service.js";
import type { StatusReserva } from "@plataformares/shared";

describe("transicionar — transições válidas", () => {
  it("pendente --aprovar--> agendada", () => {
    expect(transicionar("pendente", "aprovar")).toBe("agendada");
  });

  it("pendente --rejeitar--> rejeitada", () => {
    expect(transicionar("pendente", "rejeitar")).toBe("rejeitada");
  });

  it("agendada --iniciar_uso--> em_uso", () => {
    expect(transicionar("agendada", "iniciar_uso")).toBe("em_uso");
  });

  it("em_uso --concluir--> concluida", () => {
    expect(transicionar("em_uso", "concluir")).toBe("concluida");
  });

  it("pendente --cancelar--> cancelada", () => {
    expect(transicionar("pendente", "cancelar")).toBe("cancelada");
  });

  it("agendada --cancelar--> cancelada", () => {
    expect(transicionar("agendada", "cancelar")).toBe("cancelada");
  });

  it("em_uso --cancelar--> cancelada", () => {
    expect(transicionar("em_uso", "cancelar")).toBe("cancelada");
  });
});

describe("transicionar — transições inválidas (mínimo 3 exigidas pelo Gate)", () => {
  it("concluida → em_uso: reserva concluída não pode voltar a estar em uso", () => {
    expect(() => transicionar("concluida", "iniciar_uso")).toThrow(TransicaoInvalidaError);
  });

  it("rejeitada → agendada: reserva rejeitada não pode ser aprovada retroativamente", () => {
    expect(() => transicionar("rejeitada", "aprovar")).toThrow(TransicaoInvalidaError);
  });

  it("cancelada → pendente: cancelada é estado final, nenhuma ação a reabre", () => {
    const acoes: AcaoReserva[] = ["aprovar", "rejeitar", "iniciar_uso", "concluir", "cancelar"];
    for (const acao of acoes) {
      expect(() => transicionar("cancelada", acao)).toThrow(TransicaoInvalidaError);
    }
  });

  it("mensagem de erro identifica claramente status atual e ação tentada", () => {
    try {
      transicionar("concluida", "cancelar");
      expect.fail("deveria ter lançado TransicaoInvalidaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TransicaoInvalidaError);
      const erro = err as TransicaoInvalidaError;
      expect(erro.statusAtual).toBe("concluida");
      expect(erro.acao).toBe("cancelar");
      expect(erro.message).toContain("concluida");
      expect(erro.message).toContain("cancelar");
    }
  });

  it("pendente → em_uso: não é permitido pular a etapa de aprovação", () => {
    expect(() => transicionar("pendente", "iniciar_uso")).toThrow(TransicaoInvalidaError);
  });

  it("agendada → concluida: não é permitido pular a etapa de uso", () => {
    expect(() => transicionar("agendada", "concluir")).toThrow(TransicaoInvalidaError);
  });

  it("rejeitada é estado final, nenhuma ação a altera", () => {
    const acoes: AcaoReserva[] = ["aprovar", "rejeitar", "iniciar_uso", "concluir", "cancelar"];
    for (const acao of acoes) {
      expect(() => transicionar("rejeitada", acao)).toThrow(TransicaoInvalidaError);
    }
  });
});

describe("estadoFinal", () => {
  it.each<StatusReserva>(["concluida", "cancelada", "rejeitada"])(
    "%s é estado final",
    (status) => {
      expect(estadoFinal(status)).toBe(true);
    }
  );

  it.each<StatusReserva>(["pendente", "agendada", "em_uso"])(
    "%s NÃO é estado final",
    (status) => {
      expect(estadoFinal(status)).toBe(false);
    }
  );
});

// ==== S7 — RN-RES-07/08: aprovação simples (Gestor) e dupla aprovação (Gestor + Admin) ====

describe("exigeDuplaAprovacao (RN-RES-08)", () => {
  it("prioridade urgente exige dupla aprovação, mesmo com risco baixo", () => {
    expect(exigeDuplaAprovacao("urgente", "baixo")).toBe(true);
  });

  it("plataforma de risco alto exige dupla aprovação, mesmo com prioridade normal", () => {
    expect(exigeDuplaAprovacao("normal", "alto")).toBe(true);
  });

  it("urgente + risco alto também exige dupla aprovação (ambas as condições)", () => {
    expect(exigeDuplaAprovacao("urgente", "alto")).toBe(true);
  });

  it.each<["normal" | "alta", "baixo" | "medio"]>([
    ["normal", "baixo"],
    ["normal", "medio"],
    ["alta", "baixo"],
    ["alta", "medio"],
  ])("prioridade %s + risco %s NÃO exige dupla aprovação", (prioridade, risco) => {
    expect(exigeDuplaAprovacao(prioridade, risco)).toBe(false);
  });
});

describe("decidirAprovacao — aprovação simples pelo Gestor de Setor (RN-RES-07)", () => {
  it("Gestor aprova sozinho reserva normal em plataforma de risco baixo -> agendada", () => {
    const resultado = decidirAprovacao("gestor_setor", {
      statusAtual: "pendente",
      prioridade: "normal",
      risco: "baixo",
      aprovadoPorId: null,
    });
    expect(resultado).toEqual({ novoStatus: "agendada", campo: "aprovado_por_id" });
  });

  it("Gestor aprova sozinho reserva de prioridade alta em plataforma de risco médio -> agendada", () => {
    const resultado = decidirAprovacao("gestor_setor", {
      statusAtual: "pendente",
      prioridade: "alta",
      risco: "medio",
      aprovadoPorId: null,
    });
    expect(resultado).toEqual({ novoStatus: "agendada", campo: "aprovado_por_id" });
  });
});

describe("decidirAprovacao — dupla aprovação obrigatória (RN-RES-08), estado intermediário", () => {
  it("Gestor aprova reserva urgente: permanece pendente, grava aprovado_por_id (estado intermediário)", () => {
    const resultado = decidirAprovacao("gestor_setor", {
      statusAtual: "pendente",
      prioridade: "urgente",
      risco: "baixo",
      aprovadoPorId: null,
    });
    expect(resultado).toEqual({ novoStatus: "pendente", campo: "aprovado_por_id" });
  });

  it("Gestor aprova reserva em plataforma de risco alto: permanece pendente, grava aprovado_por_id", () => {
    const resultado = decidirAprovacao("gestor_setor", {
      statusAtual: "pendente",
      prioridade: "normal",
      risco: "alto",
      aprovadoPorId: null,
    });
    expect(resultado).toEqual({ novoStatus: "pendente", campo: "aprovado_por_id" });
  });

  it("Admin dá a segunda aprovação após o Gestor: muda para agendada, grava segunda_aprovacao_por_id", () => {
    const resultado = decidirAprovacao("admin", {
      statusAtual: "pendente",
      prioridade: "urgente",
      risco: "baixo",
      aprovadoPorId: "11111111-1111-1111-1111-111111111111", // Gestor já aprovou
    });
    expect(resultado).toEqual({ novoStatus: "agendada", campo: "segunda_aprovacao_por_id" });
  });

  it("Admin aprova diretamente, sem esperar o Gestor: agendada, grava aprovado_por_id (não segunda)", () => {
    const resultado = decidirAprovacao("admin", {
      statusAtual: "pendente",
      prioridade: "urgente",
      risco: "alto",
      aprovadoPorId: null,
    });
    expect(resultado).toEqual({ novoStatus: "agendada", campo: "aprovado_por_id" });
  });

  it("Gestor não pode aprovar de novo uma reserva que já recebeu sua primeira aprovação", () => {
    expect(() =>
      decidirAprovacao("gestor_setor", {
        statusAtual: "pendente",
        prioridade: "urgente",
        risco: "baixo",
        aprovadoPorId: "11111111-1111-1111-1111-111111111111",
      })
    ).toThrow(AprovacaoJaRealizadaError);
  });

  it("decidirAprovacao rejeita reserva que não está mais pendente (já agendada)", () => {
    expect(() =>
      decidirAprovacao("admin", {
        statusAtual: "agendada",
        prioridade: "normal",
        risco: "baixo",
        aprovadoPorId: null,
      })
    ).toThrow(TransicaoInvalidaError);
  });
});
