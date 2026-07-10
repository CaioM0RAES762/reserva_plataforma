import { describe, expect, it } from "vitest";
import {
  codigoJaCadastrado,
  normalizarCodigoPlataforma,
  resolverRiscoPlataforma,
} from "../../services/plataforma.service.js";

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

describe("resolverRiscoPlataforma (S7 — SDD §2.4, risco padrão por categoria)", () => {
  it.each([
    ["elevatoria", "alto"],
    ["andaime", "alto"],
    ["sala", "baixo"],
    ["patio", "medio"],
    ["veiculo", "medio"],
    ["outro", "baixo"],
  ] as const)("categoria %s -> risco padrão %s quando não informado", (categoria, riscoEsperado) => {
    expect(resolverRiscoPlataforma(categoria)).toBe(riscoEsperado);
  });

  it("respeita o risco informado explicitamente, sobrescrevendo o padrão da categoria", () => {
    expect(resolverRiscoPlataforma("sala", "alto")).toBe("alto");
  });
});
