import type { EmailMessage, EmailProvider, EmailSendResult } from "../../services/email/types.js";
import { EmailNaoEnviadoError } from "../../services/email/types.js";

// Provider de e-mail falso para testes: nunca toca rede/SMTP/Graph de verdade. Implementa
// o mesmo contrato (`EmailProvider`) que `SmtpEmailProvider`/`MicrosoftGraphEmailProvider`,
// então a lógica de negócio exercitada (rotas de auth, otp.service.ts) é a mesma que roda
// em produção — só o transporte é substituído.
export class MockEmailProvider implements EmailProvider {
  readonly nome = "smtp" as const;
  readonly mensagensEnviadas: EmailMessage[] = [];

  constructor(private readonly comportamento: "aceitar" | "rejeitar" = "aceitar") {}

  validarConfiguracao(): void {}

  async testarConexao(): Promise<{ ok: boolean; detalhe?: string }> {
    return { ok: this.comportamento === "aceitar" };
  }

  async enviar(mensagem: EmailMessage): Promise<EmailSendResult> {
    if (this.comportamento === "rejeitar") {
      throw new EmailNaoEnviadoError("Falha simulada pelo MockEmailProvider (teste).", "MOCK_REJECTED");
    }
    this.mensagensEnviadas.push(mensagem);
    return {
      success: true,
      provider: "smtp",
      messageId: `mock-${this.mensagensEnviadas.length}`,
      accepted: [mensagem.to],
      rejected: [],
      response: "250 mock OK",
      tempoMs: 1,
    };
  }
}

export function criarProviderMockSempreAceita(): MockEmailProvider {
  return new MockEmailProvider("aceitar");
}

export function criarProviderMockSempreRejeita(): MockEmailProvider {
  return new MockEmailProvider("rejeitar");
}
