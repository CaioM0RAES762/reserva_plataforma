import { Client } from "@microsoft/microsoft-graph-client";
import { EmailNaoEnviadoError, type EmailMessage, type EmailProvider, type EmailSendResult } from "./types.js";

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderEmail: string;
}

export function lerConfigGraphDoAmbiente(): GraphConfig | null {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  const senderEmail = process.env.GRAPH_SENDER ?? process.env.GRAPH_SENDER_EMAIL;
  if (!tenantId || !clientId || !clientSecret || !senderEmail) return null;
  return { tenantId, clientId, clientSecret, senderEmail };
}

// Envio via Microsoft Graph, alinhado ao domínio real do destinatário (metalsider.com.br)
// quando GRAPH_SENDER é uma caixa do próprio tenant M365 — resolve por completo o problema
// de deliverability que um remetente Gmail externo tem contra Exchange Online/Defender
// (SPF/DKIM/DMARC alinhados ao domínio, sem heurística de impersonação de marca).
export class MicrosoftGraphEmailProvider implements EmailProvider {
  readonly nome = "graph" as const;
  private tokenCache: { token: string; expiraEm: number } | null = null;

  constructor(private readonly config: GraphConfig | null) {}

  validarConfiguracao(): void {
    if (!this.config) {
      throw new Error(
        "EMAIL_PROVIDER=graph exige GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/GRAPH_SENDER."
      );
    }
  }

  private async obterToken(): Promise<string> {
    if (!this.config) throw new Error("MicrosoftGraphEmailProvider usado sem configuração válida.");
    // Reaproveita o token entre envios até ~1min antes de expirar — evita um round-trip de
    // autenticação por mensagem em rajadas curtas (mesmo motivo do pool do SMTP).
    if (this.tokenCache && this.tokenCache.expiraEm > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !json.access_token) {
      throw new EmailNaoEnviadoError(
        `Falha ao obter token do Microsoft Graph (${json.error ?? response.status}).`,
        "GRAPH_AUTH_FAILED",
        json.error_description ?? json.error
      );
    }
    this.tokenCache = { token: json.access_token, expiraEm: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private getClient(token: string): Client {
    return Client.init({ authProvider: (done) => done(null, token) });
  }

  async testarConexao(): Promise<{ ok: boolean; detalhe?: string }> {
    try {
      await this.obterToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, detalhe: err instanceof Error ? err.message : String(err) };
    }
  }

  async enviar(mensagem: EmailMessage): Promise<EmailSendResult> {
    if (!this.config) throw new Error("MicrosoftGraphEmailProvider usado sem configuração válida.");
    const inicio = Date.now();
    try {
      const token = await this.obterToken();
      const client = this.getClient(token);
      // `/sendMail` do Graph responde 202 Accepted sem corpo e sem message-id — não há como
      // pedir os dois formatos (HTML+texto) nesta chamada simplificada; content=HTML é o que
      // a maioria dos clientes Outlook renderiza, e é o que já era enviado antes.
      await client.api(`/users/${this.config.senderEmail}/sendMail`).post({
        message: {
          subject: mensagem.subject,
          body: { contentType: "HTML", content: mensagem.html },
          toRecipients: [{ emailAddress: { address: mensagem.to } }],
          replyTo: mensagem.replyTo ? [{ emailAddress: { address: mensagem.replyTo } }] : undefined,
        },
        saveToSentItems: true,
      });
      return {
        success: true,
        provider: "graph",
        accepted: [mensagem.to],
        rejected: [],
        response: "202 Accepted (Graph sendMail não retorna messageId síncrono)",
        tempoMs: Date.now() - inicio,
      };
    } catch (err) {
      if (err instanceof EmailNaoEnviadoError) throw err;
      // A mensagem original do Graph pode conter tenant/endpoint — fica só em causaOriginal
      // (log do servidor), nunca na resposta ao cliente.
      const codigo = extrairCodigoErroGraph(err);
      throw new EmailNaoEnviadoError(`Falha ao enviar e-mail pelo Microsoft Graph (${codigo}).`, codigo, err);
    }
  }
}

function extrairCodigoErroGraph(err: unknown): string {
  if (err && typeof err === "object") {
    const comCodigo = err as { code?: string; statusCode?: number };
    if (comCodigo.code) return comCodigo.code;
    if (comCodigo.statusCode) return `GRAPH_${comCodigo.statusCode}`;
  }
  return "GRAPH_UNKNOWN_ERROR";
}
