import { Client } from "@microsoft/microsoft-graph-client";
import "dotenv/config";

// Node 20+ possui fetch nativo — sem necessidade de isomorphic-fetch.

export interface EmailJobData {
  destinatario: string;
  assunto: string;
  corpoHtml: string;
}

function getGraphClient(): Client {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Credenciais do Microsoft Graph não configuradas (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET)."
    );
  }

  return Client.init({
    authProvider: async (done) => {
      try {
        const params = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        });
        const response = await fetch(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          { method: "POST", body: params }
        );
        const json = (await response.json()) as { access_token?: string; error?: string };
        if (!json.access_token) {
          throw new Error(json.error ?? "Falha ao obter token do Microsoft Graph");
        }
        done(null, json.access_token);
      } catch (err) {
        done(err as Error, null);
      }
    },
  });
}

export async function enviarEmail(data: EmailJobData): Promise<void> {
  const senderEmail = process.env.GRAPH_SENDER_EMAIL;
  if (!senderEmail) {
    throw new Error("GRAPH_SENDER_EMAIL não configurado.");
  }

  const client = getGraphClient();

  await client.api(`/users/${senderEmail}/sendMail`).post({
    message: {
      subject: data.assunto,
      body: { contentType: "HTML", content: data.corpoHtml },
      toRecipients: [{ emailAddress: { address: data.destinatario } }],
    },
    saveToSentItems: true,
  });
}

export function templateCodigoVerificacao(codigo: string, tipo: "ativacao_conta" | "reset_senha"): {
  assunto: string;
  corpoHtml: string;
} {
  const titulo = tipo === "ativacao_conta" ? "Ativação de conta" : "Redefinição de senha";
  return {
    assunto: `PlataformaRes — Código de verificação (${titulo})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>${titulo}</h2>
        <p>Use o código abaixo para continuar. Ele expira em 15 minutos e só pode ser usado uma vez.</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${codigo}</p>
        <p style="color: #666; font-size: 12px;">Se você não solicitou isso, ignore este e-mail.</p>
      </div>
    `,
  };
}

export interface DadosNovaReservaPendente {
  plataformaNome: string;
  setorNome: string;
  solicitanteNome: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  motivo: string;
  prioridade: string;
}

export function templateNovaReservaPendente(dados: DadosNovaReservaPendente): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Nova reserva pendente (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Nova reserva aguardando aprovação</h2>
        <p><strong>${dados.solicitanteNome}</strong> (${dados.setorNome}) solicitou o uso de <strong>${dados.plataformaNome}</strong>.</p>
        <table style="font-size: 14px; color: #333;">
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Data</td><td>${dados.data}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Horário</td><td>${dados.horaInicio} – ${dados.horaFim}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Prioridade</td><td>${dados.prioridade}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Motivo</td><td>${dados.motivo}</td></tr>
        </table>
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para aprovar ou rejeitar esta solicitação.</p>
      </div>
    `,
  };
}
