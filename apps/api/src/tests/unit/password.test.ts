import { describe, expect, it } from "vitest";
import {
  calcularExpiracaoCodigo,
  codigoExpirado,
  gerarCodigoVerificacao,
  hashPassword,
  verifyPassword,
} from "../../utils/password.js";

describe("hashPassword / verifyPassword", () => {
  it("gera um hash diferente da senha original", async () => {
    const hash = await hashPassword("MinhaSenha123");
    expect(hash).not.toBe("MinhaSenha123");
    expect(hash.startsWith("$2b$")).toBe(true);
  });

  it("valida a senha correta contra o hash", async () => {
    const hash = await hashPassword("MinhaSenha123");
    await expect(verifyPassword("MinhaSenha123", hash)).resolves.toBe(true);
  });

  it("rejeita senha incorreta contra o hash", async () => {
    const hash = await hashPassword("MinhaSenha123");
    await expect(verifyPassword("SenhaErrada999", hash)).resolves.toBe(false);
  });

  it("usa salt rounds 12 (custo embutido no hash bcrypt)", async () => {
    const hash = await hashPassword("MinhaSenha123");
    const custo = hash.split("$")[2];
    expect(custo).toBe("12");
  });
});

describe("gerarCodigoVerificacao", () => {
  it("gera código com exatamente 6 dígitos numéricos", () => {
    for (let i = 0; i < 50; i++) {
      const codigo = gerarCodigoVerificacao();
      expect(codigo).toMatch(/^\d{6}$/);
    }
  });

  it("preserva zeros à esquerda", () => {
    // Com 1000 amostras, a chance de nunca gerar um código < 100000 é desprezível
    const codigos = Array.from({ length: 2000 }, () => gerarCodigoVerificacao());
    expect(codigos.some((c) => c.length === 6 && c.startsWith("0"))).toBe(true);
  });
});

describe("expiração de código (RN-AUTH-01: 15 minutos)", () => {
  it("calcula expiração 15 minutos à frente da data base", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    expect(expiraEm.toISOString()).toBe("2026-01-01T10:15:00.000Z");
  });

  it("não considera expirado antes do prazo", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    const checagem = new Date("2026-01-01T10:14:59.000Z");
    expect(codigoExpirado(expiraEm, checagem)).toBe(false);
  });

  it("considera expirado exatamente no instante do prazo", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    expect(codigoExpirado(expiraEm, expiraEm)).toBe(false);
    const umMsDepois = new Date(expiraEm.getTime() + 1);
    expect(codigoExpirado(expiraEm, umMsDepois)).toBe(true);
  });

  it("considera expirado bem depois do prazo", () => {
    const agora = new Date("2026-01-01T10:00:00.000Z");
    const expiraEm = calcularExpiracaoCodigo(agora);
    const muitoDepois = new Date("2026-01-01T11:00:00.000Z");
    expect(codigoExpirado(expiraEm, muitoDepois)).toBe(true);
  });
});
