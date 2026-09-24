import { describe, expect, it, vi } from "vitest";
import { ehDeadlockSql, executarComRepeticaoEmDeadlock } from "../../services/disponibilidade.service.js";

// O key-range lock de POST /reservas pode terminar em "vítima de deadlock" (SQL Server 1205)
// com 3+ requisições simultâneas no mesmo dia. A repetição devolve a decisão ao caminho normal
// (201 ou 409) em vez de um 500 — mas só para deadlock, e sem repetir indefinidamente.

function erroDeadlock(): Error & { number: number } {
  return Object.assign(new Error("Transaction was deadlocked"), { number: 1205 });
}

const semEspera = async () => undefined;

describe("ehDeadlockSql", () => {
  it("reconhece o erro 1205 do driver, direto ou aninhado", () => {
    expect(ehDeadlockSql(erroDeadlock())).toBe(true);
    expect(ehDeadlockSql({ originalError: { info: { number: 1205 } } })).toBe(true);
  });

  it("não confunde outros erros de SQL nem valores estranhos", () => {
    expect(ehDeadlockSql(Object.assign(new Error("dup"), { number: 2627 }))).toBe(false);
    expect(ehDeadlockSql(new Error("qualquer"))).toBe(false);
    expect(ehDeadlockSql(null)).toBe(false);
    expect(ehDeadlockSql(undefined)).toBe(false);
  });
});

describe("executarComRepeticaoEmDeadlock", () => {
  it("sem erro, executa uma vez só e devolve o resultado", async () => {
    const operacao = vi.fn(async () => "ok");
    await expect(executarComRepeticaoEmDeadlock(operacao, 4, semEspera)).resolves.toBe("ok");
    expect(operacao).toHaveBeenCalledTimes(1);
  });

  it("repete quando é vítima de deadlock e devolve o resultado da tentativa que der certo", async () => {
    const operacao = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(erroDeadlock())
      .mockRejectedValueOnce(erroDeadlock())
      .mockResolvedValueOnce("venceu");
    await expect(executarComRepeticaoEmDeadlock(operacao, 4, semEspera)).resolves.toBe("venceu");
    expect(operacao).toHaveBeenCalledTimes(3);
  });

  it("outro erro é propagado na hora, sem repetir", async () => {
    const falha = new Error("violação de FK");
    const operacao = vi.fn(async () => {
      throw falha;
    });
    await expect(executarComRepeticaoEmDeadlock(operacao, 4, semEspera)).rejects.toBe(falha);
    expect(operacao).toHaveBeenCalledTimes(1);
  });

  it("deadlock persistente esgota as tentativas e propaga o erro original", async () => {
    const operacao = vi.fn(async () => {
      throw erroDeadlock();
    });
    await expect(executarComRepeticaoEmDeadlock(operacao, 3, semEspera)).rejects.toMatchObject({ number: 1205 });
    expect(operacao).toHaveBeenCalledTimes(3);
  });

  it("espera antes de cada nova tentativa (para não repetir o ciclo em uníssono)", async () => {
    const esperas: number[] = [];
    const operacao = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(erroDeadlock())
      .mockResolvedValueOnce("ok");
    await executarComRepeticaoEmDeadlock(operacao, 4, async (ms) => {
      esperas.push(ms);
    });
    expect(esperas).toHaveLength(1);
    expect(esperas[0]).toBeGreaterThan(0);
  });
});
