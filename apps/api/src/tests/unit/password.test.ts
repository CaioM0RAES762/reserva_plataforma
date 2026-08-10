import { describe, expect, it } from "vitest";
import {
  calcularExpiracaoCodigo,
  codigoExpirado,
  codigosConferem,
  gerarCodigoVerificacao,
} from "../../utils/password.js";

describe("gerarCodigoVerificacao", () => {
  it("sempre gera 6 dígitos numéricos, com zero à esquerda quando necessário", () => {
    for (let i = 0; i < 200; i++) {
      const codigo = gerarCodigoVerificacao();
      expect(codigo).toMatch(/^\d{6}$/);
    }
  });

  it("não é constante nem segue um padrão trivial (sanidade de aleatoriedade)", () => {
    const codigos = new Set(Array.from({ length: 200 }, () => gerarCodigoVerificacao()));
    // Com 200 amostras de um espaço de 1.000.000, colisões são estatisticamente raras;
    // exigir >150 valores distintos detecta um gerador quebrado (ex.: sempre "000000",
    // ou um contador previsível) sem ser um teste de qualidade estatística do PRNG.
    expect(codigos.size).toBeGreaterThan(150);
  });
});

describe("codigosConferem", () => {
  it("retorna true para códigos idênticos", () => {
    expect(codigosConferem("482913", "482913")).toBe(true);
  });

  it("retorna false para códigos diferentes de mesmo tamanho", () => {
    expect(codigosConferem("482913", "482914")).toBe(false);
  });

  it("retorna false (sem lançar) para tamanhos diferentes", () => {
    expect(codigosConferem("482913", "4829130")).toBe(false);
    expect(codigosConferem("", "482913")).toBe(false);
  });
});

describe("calcularExpiracaoCodigo / codigoExpirado", () => {
  it("expira exatamente 15 minutos após a emissão", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    expect(expiraEm.toISOString()).toBe("2026-01-01T10:15:00.000Z");
  });

  it("não está expirado antes do horário de expiração", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    const umSegundoAntes = new Date(expiraEm.getTime() - 1000);
    expect(codigoExpirado(expiraEm, umSegundoAntes)).toBe(false);
  });

  it("está expirado depois do horário de expiração", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    const umSegundoDepois = new Date(expiraEm.getTime() + 1000);
    expect(codigoExpirado(expiraEm, umSegundoDepois)).toBe(true);
  });
});
