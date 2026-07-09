import { describe, expect, it } from "vitest";
import { codigoJaCadastrado, normalizarCodigoPlataforma } from "../../services/plataforma.service.js";

describe("normalizarCodigoPlataforma", () => {
  it("remove espaços nas extremidades e converte para maiúsculas", () => {
    expect(normalizarCodigoPlataforma("  plt-001 ")).toBe("PLT-001");
  });

  it("é idempotente para um código já normalizado", () => {
    expect(normalizarCodigoPlataforma("PLT-001")).toBe("PLT-001");
  });
});

describe("codigoJaCadastrado (rejeição de código duplicado)", () => {
  const existentes = ["PLT-001", "PLT-002", "AND-001"];

  it("rejeita código idêntico", () => {
    expect(codigoJaCadastrado(existentes, "PLT-001")).toBe(true);
  });

  it("rejeita código duplicado ignorando diferença de maiúsculas/minúsculas", () => {
    expect(codigoJaCadastrado(existentes, "plt-001")).toBe(true);
  });

  it("rejeita código duplicado ignorando espaços nas extremidades", () => {
    expect(codigoJaCadastrado(existentes, "  PLT-002  ")).toBe(true);
  });

  it("aceita código novo, não existente na lista", () => {
    expect(codigoJaCadastrado(existentes, "PLT-003")).toBe(false);
  });

  it("retorna falso para lista vazia", () => {
    expect(codigoJaCadastrado([], "PLT-001")).toBe(false);
  });
});
