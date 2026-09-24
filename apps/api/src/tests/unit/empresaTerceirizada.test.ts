import { describe, expect, it } from "vitest";
import {
  criarReservaSchema,
  EMPRESA_TERCEIRIZADA_MAX,
  MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA,
  MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA,
  normalizarEmpresaTerceirizada,
  normalizarNomeSetor,
  setorExigeEmpresaTerceirizada,
  validarEmpresaTerceirizada,
} from "@plataformares/shared";

// Regra "reserva de Terceirizados exige a empresa" — fonte única do formulário e de POST
// /reservas. Se a comparação de nomes divergir, o front deixa passar o que o backend recusa.

describe("normalizarNomeSetor / setorExigeEmpresaTerceirizada", () => {
  it("ignora caixa, acento e espaços nas pontas e repetidos", () => {
    expect(normalizarNomeSetor("  TERCEIRIZÁDOS  ")).toBe("terceirizados");
    expect(normalizarNomeSetor("Terceirizados")).toBe("terceirizados");
    expect(normalizarNomeSetor("Manutenção  Predial")).toBe("manutencao predial");
  });

  it.each(["Terceirizados", "terceirizados", "TERCEIRIZADOS", "  Terceirizados  ", "Térceirizados"])(
    "exige a empresa para o setor %j",
    (nome) => {
      expect(setorExigeEmpresaTerceirizada(nome)).toBe(true);
    }
  );

  it.each(["TI", "Manutenção", "Terceirizado", "Terceirizados Externos", "Não Terceirizados", "", "   "])(
    "não exige a empresa para o setor %j",
    (nome) => {
      expect(setorExigeEmpresaTerceirizada(nome)).toBe(false);
    }
  );

  it("nome ausente (setor inexistente) não dispara a regra", () => {
    expect(setorExigeEmpresaTerceirizada(null)).toBe(false);
    expect(setorExigeEmpresaTerceirizada(undefined)).toBe(false);
  });
});

describe("normalizarEmpresaTerceirizada", () => {
  it("apara as pontas e colapsa espaços internos", () => {
    expect(normalizarEmpresaTerceirizada("  ACME   Montagens \t Ltda ")).toBe("ACME Montagens Ltda");
  });

  it("vazio, só espaços e ausente viram string vazia ('não informado')", () => {
    expect(normalizarEmpresaTerceirizada("")).toBe("");
    expect(normalizarEmpresaTerceirizada("     ")).toBe("");
    expect(normalizarEmpresaTerceirizada(null)).toBe("");
    expect(normalizarEmpresaTerceirizada(undefined)).toBe("");
  });

  it("preserva acentos", () => {
    expect(normalizarEmpresaTerceirizada(" Construções   Ávila ")).toBe("Construções Ávila");
  });
});

describe("validarEmpresaTerceirizada", () => {
  it("exigida + vazio, só espaços ou ausente → mensagem de obrigatoriedade", () => {
    expect(validarEmpresaTerceirizada("", true)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA);
    expect(validarEmpresaTerceirizada("     ", true)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA);
    expect(validarEmpresaTerceirizada(undefined, true)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA);
    expect(validarEmpresaTerceirizada(null, true)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_OBRIGATORIA);
  });

  it("exigida + nome informado → válido", () => {
    expect(validarEmpresaTerceirizada("ACME Montagens", true)).toBeNull();
  });

  it("não exigida + vazio → válido", () => {
    expect(validarEmpresaTerceirizada("", false)).toBeNull();
    expect(validarEmpresaTerceirizada(undefined, false)).toBeNull();
  });

  it("limite de 120 caracteres: 120 passa, 121 não (exigida ou não)", () => {
    expect(EMPRESA_TERCEIRIZADA_MAX).toBe(120);
    expect(validarEmpresaTerceirizada("a".repeat(120), true)).toBeNull();
    expect(validarEmpresaTerceirizada("a".repeat(121), true)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA);
    expect(validarEmpresaTerceirizada("a".repeat(121), false)).toBe(MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA);
  });

  it("o limite vale para o valor NORMALIZADO (espaços que colapsam não contam)", () => {
    const comMuitosEspacos = `a${" ".repeat(200)}b`;
    expect(validarEmpresaTerceirizada(comMuitosEspacos, true)).toBeNull();
  });
});

describe("criarReservaSchema — empresaTerceirizada", () => {
  const base = {
    plataformaId: "3f1d3e0e-6b0b-4c8e-9c5b-2b1f0a9c7d11",
    data: "2030-01-15",
    horaInicio: "08:00",
    horaFim: "09:00",
    quantidadePessoas: 1,
    motivo: "Manutenção preventiva",
    telefoneContato: "(11) 91234-5678",
  };

  it("omitida vira string vazia (a obrigatoriedade é decidida pela rota, que conhece o setor)", () => {
    const resultado = criarReservaSchema.safeParse(base);
    expect(resultado.success).toBe(true);
    if (resultado.success) expect(resultado.data.empresaTerceirizada).toBe("");
  });

  it("normaliza o valor enviado", () => {
    const resultado = criarReservaSchema.safeParse({ ...base, empresaTerceirizada: "  ACME   Ltda " });
    expect(resultado.success).toBe(true);
    if (resultado.success) expect(resultado.data.empresaTerceirizada).toBe("ACME Ltda");
  });

  it("acima de 120 caracteres reprova no campo empresaTerceirizada", () => {
    const resultado = criarReservaSchema.safeParse({ ...base, empresaTerceirizada: "x".repeat(121) });
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.flatten().fieldErrors.empresaTerceirizada).toEqual([
        MENSAGEM_EMPRESA_TERCEIRIZADA_LONGA,
      ]);
    }
  });
});
