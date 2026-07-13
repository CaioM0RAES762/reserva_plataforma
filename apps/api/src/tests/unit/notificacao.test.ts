import { describe, expect, it, vi } from "vitest";
import { sql } from "../../db/pool.js";
import { registrarNotificacao } from "../../services/notificacao.service.js";

function criarTransactionFake(retorno: { id: string; criado_em: Date }): sql.Transaction {
  const request = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset: [retorno] }),
  };
  return { request: vi.fn(() => request) } as unknown as sql.Transaction;
}

describe("notificacao.service — registrarNotificacao (S10)", () => {
  it("insere a notificação e retorna o objeto mapeado com lida=false", async () => {
    const criadoEm = new Date("2026-08-01T10:00:00.000Z");
    const transaction = criarTransactionFake({ id: "NOTIF-1", criado_em: criadoEm });

    const resultado = await registrarNotificacao(transaction, {
      usuarioId: "USR-1",
      tipo: "reserva_pendente",
      titulo: "Nova reserva pendente",
      mensagem: "Mensagem de teste",
      link: "/reservas/aprovacoes",
    });

    expect(resultado).toEqual({
      id: "NOTIF-1",
      usuarioId: "USR-1",
      tipo: "reserva_pendente",
      titulo: "Nova reserva pendente",
      mensagem: "Mensagem de teste",
      link: "/reservas/aprovacoes",
      lida: false,
      criadoEm: criadoEm.toISOString(),
    });
  });

  it("usa link nulo quando não informado", async () => {
    const transaction = criarTransactionFake({ id: "NOTIF-2", criado_em: new Date("2026-08-02T00:00:00.000Z") });

    const resultado = await registrarNotificacao(transaction, {
      usuarioId: "USR-2",
      tipo: "reserva_aprovada",
      titulo: "Reserva aprovada",
      mensagem: "Sua reserva foi aprovada.",
    });

    expect(resultado.link).toBeNull();
  });
});
