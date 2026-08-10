import nodemailer, { type Transporter } from "nodemailer";
import { EmailNaoEnviadoError, type EmailMessage, type EmailProvider, type EmailSendResult } from "./types.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function lerConfigSmtpDoAmbiente(): SmtpConfig | null {
  const host = process.env.SMTP_HOST ?? process.env.EMAIL_HOST;
  const user = process.env.SMTP_USER ?? process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS ?? process.env.EMAIL_PASSWORD;
  if (!host || !user || !pass) return null;

  const porta = Number(process.env.SMTP_PORT ?? process.env.EMAIL_PORT ?? 587);
  const nomeRemetente = process.env.EMAIL_FROM_NAME;
  const enderecoRemetente = process.env.EMAIL_FROM || user;
  const from = nomeRemetente ? `${nomeRemetente} <${user}>` : enderecoRemetente;

  return {
    host,
    port: porta,
    secure: process.env.SMTP_SECURE === "true" || process.env.EMAIL_SECURE === "true" || porta === 465,
    user,
    pass,
    from,
  };
}

export class SmtpEmailProvider implements EmailProvider {
  readonly nome = "smtp" as const;
  private transporte: Transporter | null = null;

  constructor(private readonly config: SmtpConfig | null) {}

  validarConfiguracao(): void {
    if (!this.config) {
      throw new Error(
        "EMAIL_PROVIDER=smtp exige SMTP_HOST/SMTP_USER/SMTP_PASS (ou EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD)."
      );
    }
  }

  private getTransporte(): Transporter {
    if (this.transporte) return this.transporte;
    if (!this.config) throw new Error("SmtpEmailProvider usado sem configuração válida.");

    this.transporte = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      // EMAIL_SECURE=true ⇒ TLS direto (porta 465). Em 587 o correto é `secure:false`, que
      // negocia STARTTLS logo após a conexão — não é envio sem criptografia.
      secure: this.config.secure,
      requireTLS: !this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      // Conexão reaproveitada entre envios (evita handshake TLS + login a cada mensagem em
      // rajadas curtas: código emitido, reenvio, notificações).
      pool: true,
      maxConnections: 3,
      // Sem timeouts explícitos, uma rede instável deixa a rota de auth pendurada até o
      // timeout do cliente HTTP — o usuário via um spinner infinito em vez de um erro real.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporte;
  }

  async testarConexao(): Promise<{ ok: boolean; detalhe?: string }> {
    try {
      await this.getTransporte().verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, detalhe: err instanceof Error ? err.message : String(err) };
    }
  }

  async enviar(mensagem: EmailMessage): Promise<EmailSendResult> {
    if (!this.config) throw new Error("SmtpEmailProvider usado sem configuração válida.");
    const inicio = Date.now();
    try {
      const info = await this.getTransporte().sendMail({
        from: this.config.from,
        to: mensagem.to,
        subject: mensagem.subject,
        html: mensagem.html,
        text: mensagem.text,
        replyTo: mensagem.replyTo,
      });

      const accepted: string[] = (info.accepted ?? []).map((addr: unknown) => String(addr));
      const rejected: string[] = (info.rejected ?? []).map((addr: unknown) => String(addr));
      const tempoMs = Date.now() - inicio;

      // "sendMail não lançou" não é "enviado": o SMTP pode aceitar a chamada e ainda
      // assim rejeitar o destinatário especificado (accepted vazio, ou o endereço cai em
      // `rejected`/`pending`). Só é sucesso se o destinatário pedido está em `accepted`.
      const destinatarioAceito = accepted.some((addr: string) => normalizarEndereco(addr) === normalizarEndereco(mensagem.to));
      if (!destinatarioAceito) {
        throw new EmailNaoEnviadoError(
          `Servidor SMTP não confirmou aceite do destinatário (accepted=${JSON.stringify(accepted)}, rejected=${JSON.stringify(rejected)}).`,
          "SMTP_RECIPIENT_NOT_ACCEPTED"
        );
      }

      return {
        success: true,
        provider: "smtp",
        messageId: info.messageId,
        accepted,
        rejected,
        response: info.response,
        tempoMs,
      };
    } catch (err) {
      const tempoMs = Date.now() - inicio;
      if (err instanceof EmailNaoEnviadoError) {
        throw err;
      }
      const codigo = extrairCodigoErroSmtp(err);
      throw new EmailNaoEnviadoError(
        `Falha ao enviar e-mail pelo servidor SMTP (${codigo}).`,
        codigo,
        err
      );
    }
  }
}

function normalizarEndereco(endereco: string): string {
  // nodemailer devolve endereços já normalizados, mas pode incluir nome de exibição
  // (`"Nome" <a@b.com>`) dependendo do transporte — extrai só a parte do e-mail.
  const match = endereco.match(/<([^>]+)>/);
  return (match ? match[1] : endereco).trim().toLowerCase();
}

function extrairCodigoErroSmtp(err: unknown): string {
  if (err && typeof err === "object") {
    const comCodigo = err as { code?: string; responseCode?: number };
    if (comCodigo.code) return comCodigo.code;
    if (comCodigo.responseCode) return `SMTP_${comCodigo.responseCode}`;
  }
  return "SMTP_UNKNOWN_ERROR";
}
