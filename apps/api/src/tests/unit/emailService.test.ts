import { afterEach, describe, expect, it } from "vitest";
import { definirProviderEmailParaTeste, enviarEmail, EmailNaoEnviadoError } from "../../services/email.service.js";
import { criarProviderMockSempreAceita, criarProviderMockSempreRejeita } from "../helpers/emailProviderMock.js";

afterEach(() => {
  definirProviderEmailParaTeste(null);
});

describe("enviarEmail", () => {
  it("retorna resultado estruturado de sucesso quando o provedor aceita", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    const resultado = await enviarEmail(
      { destinatario: "alguem@metalsider.com.br", assunto: "Assunto", corpoHtml: "<p>oi</p>" },
      { tipo: "ACTIVATION" }
    );

    expect(resultado.success).toBe(true);
    expect(resultado.provider).toBe("smtp");
    expect(resultado.messageId).toBeDefined();
    expect(resultado.accepted).toEqual(["alguem@metalsider.com.br"]);
    expect(resultado.rejected).toEqual([]);
    expect(mock.mensagensEnviadas).toHaveLength(1);
  });

  it("deriva a versão texto puro do HTML quando corpoTexto não é fornecido", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    await enviarEmail(
      { destinatario: "alguem@metalsider.com.br", assunto: "Assunto", corpoHtml: "<p>Código: <b>123456</b></p>" },
      { tipo: "ACTIVATION" }
    );

    expect(mock.mensagensEnviadas[0].text).toContain("Código: 123456");
    expect(mock.mensagensEnviadas[0].text).not.toContain("<");
  });

  it("usa a versão texto explícita quando fornecida, em vez de derivar do HTML", async () => {
    const mock = criarProviderMockSempreAceita();
    definirProviderEmailParaTeste(mock);

    await enviarEmail(
      {
        destinatario: "alguem@metalsider.com.br",
        assunto: "Assunto",
        corpoHtml: "<p>versão HTML</p>",
        corpoTexto: "versão texto escrita à mão",
      },
      { tipo: "ACTIVATION" }
    );

    expect(mock.mensagensEnviadas[0].text).toBe("versão texto escrita à mão");
  });

  it("lança EmailNaoEnviadoError (nunca finge sucesso) quando o provedor rejeita", async () => {
    definirProviderEmailParaTeste(criarProviderMockSempreRejeita());

    await expect(
      enviarEmail(
        { destinatario: "alguem@metalsider.com.br", assunto: "Assunto", corpoHtml: "<p>oi</p>" },
        { tipo: "PASSWORD_RESET" }
      )
    ).rejects.toBeInstanceOf(EmailNaoEnviadoError);
  });
});
