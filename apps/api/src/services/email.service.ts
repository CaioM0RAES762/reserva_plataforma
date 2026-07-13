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

export interface DadosDecisaoReserva {
  plataformaNome: string;
  data: string;
  horaInicio: string;
  horaFim: string;
}

export function templateReservaAprovada(dados: DadosDecisaoReserva): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Reserva aprovada (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#16A34A;">Reserva aprovada</h2>
        <p>Sua solicitação de uso de <strong>${dados.plataformaNome}</strong> foi aprovada e está agendada.</p>
        <table style="font-size: 14px; color: #333;">
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Data</td><td>${dados.data}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Horário</td><td>${dados.horaInicio} – ${dados.horaFim}</td></tr>
        </table>
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para mais detalhes.</p>
      </div>
    `,
  };
}

export interface DadosSegundaAprovacaoNecessaria extends DadosDecisaoReserva {
  gestorNome: string;
}

// UC-02 (S7): quando o Gestor de Setor dá a primeira aprovação num caso de dupla
// aprovação (RN-RES-08), o Admin é notificado de que falta a segunda decisão.
export function templateSegundaAprovacaoNecessaria(dados: DadosSegundaAprovacaoNecessaria): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Segunda aprovação necessária (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#D97706;">Segunda aprovação necessária</h2>
        <p><strong>${dados.gestorNome}</strong> já aprovou o uso de <strong>${dados.plataformaNome}</strong>, mas esta reserva exige aprovação adicional do Admin (prioridade urgente ou plataforma de risco alto).</p>
        <table style="font-size: 14px; color: #333;">
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Data</td><td>${dados.data}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Horário</td><td>${dados.horaInicio} – ${dados.horaFim}</td></tr>
        </table>
        <p style="color: #666; font-size: 12px;">Acesse a Fila de Aprovações no PlataformaRes para decidir.</p>
      </div>
    `,
  };
}

export interface DadosEscalonamentoSla extends DadosDecisaoReserva {
  slaHoras: number;
}

// RN-RES-09 (S7): reserva urgente sem decisão dentro do SLA configurado é escalada ao Admin.
export function templateEscalonamentoSla(dados: DadosEscalonamentoSla): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — SLA de aprovação estourado (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#DC2626;">Reserva urgente sem decisão dentro do SLA</h2>
        <p>Uma reserva de prioridade <strong>urgente</strong> para <strong>${dados.plataformaNome}</strong> está pendente há mais de ${dados.slaHoras}h sem aprovação ou rejeição.</p>
        <table style="font-size: 14px; color: #333;">
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Data</td><td>${dados.data}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Horário</td><td>${dados.horaInicio} – ${dados.horaFim}</td></tr>
        </table>
        <p style="color: #666; font-size: 12px;">Acesse a Fila de Aprovações no PlataformaRes com urgência.</p>
      </div>
    `,
  };
}

export interface DadosChecklistNaoConforme {
  plataformaNome: string;
  setorNome: string;
}

// RF-CHK-03/RN-CHK-02 (S8): item obrigatório não conforme não muda o status da
// plataforma automaticamente — apenas notifica o Admin para revisão manual.
export function templateChecklistNaoConforme(dados: DadosChecklistNaoConforme): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Checklist com não conformidade (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#DC2626;">Checklist de segurança com item não conforme</h2>
        <p>O checklist de segurança de <strong>${dados.plataformaNome}</strong> (setor ${dados.setorNome}) foi preenchido com pelo menos um item obrigatório não conforme.</p>
        <p>O início de uso desta reserva está bloqueado (RN-CHK-02). Revise a plataforma e, se necessário, marque-a como em manutenção.</p>
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para ver o detalhe do checklist.</p>
      </div>
    `,
  };
}

export interface DadosComentarioNovo {
  plataformaNome: string;
  autorNome: string;
  mensagem: string;
}

// RF-RES-15 (S11): notifica o(s) outro(s) participante(s) da conversa quando alguém
// comenta numa reserva.
export function templateComentarioNovo(dados: DadosComentarioNovo): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Novo comentário (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Novo comentário na reserva</h2>
        <p><strong>${dados.autorNome}</strong> comentou na reserva de <strong>${dados.plataformaNome}</strong>:</p>
        <p style="background:#f5f5f5; padding: 10px; border-radius: 4px; font-size: 14px;">${dados.mensagem}</p>
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para responder.</p>
      </div>
    `,
  };
}

export interface DadosOcorrenciaGrave {
  plataformaNome: string;
  setorNome: string;
  descricao: string;
  geraManutencao: boolean;
}

// RF-RES-16/RN-PLAT-04 (S11): ocorrência de gravidade alta sempre notifica o Admin,
// independente de gerar manutenção automática ou não.
export function templateOcorrenciaGrave(dados: DadosOcorrenciaGrave): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Ocorrência grave reportada (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#DC2626;">Ocorrência de gravidade alta</h2>
        <p>Uma ocorrência de gravidade <strong>alta</strong> foi reportada para <strong>${dados.plataformaNome}</strong> (setor ${dados.setorNome}).</p>
        <p style="background:#f5f5f5; padding: 10px; border-radius: 4px; font-size: 14px;">${dados.descricao}</p>
        ${
          dados.geraManutencao
            ? '<p style="color:#DC2626; font-size: 14px;"><strong>A plataforma foi movida automaticamente para manutenção e novas reservas estão bloqueadas (RN-PLAT-04).</strong></p>'
            : ""
        }
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para revisar a plataforma.</p>
      </div>
    `,
  };
}

export interface DadosRejeicaoReserva extends DadosDecisaoReserva {
  motivo: string;
}

export function templateReservaRejeitada(dados: DadosRejeicaoReserva): {
  assunto: string;
  corpoHtml: string;
} {
  return {
    assunto: `PlataformaRes — Reserva rejeitada (${dados.plataformaNome})`,
    corpoHtml: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#DC2626;">Reserva rejeitada</h2>
        <p>Sua solicitação de uso de <strong>${dados.plataformaNome}</strong> foi rejeitada.</p>
        <table style="font-size: 14px; color: #333;">
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Data</td><td>${dados.data}</td></tr>
          <tr><td style="padding: 2px 8px 2px 0;color:#666;">Horário</td><td>${dados.horaInicio} – ${dados.horaFim}</td></tr>
        </table>
        <p style="font-size: 14px;"><strong>Motivo:</strong> ${dados.motivo}</p>
        <p style="color: #666; font-size: 12px;">Acesse o PlataformaRes para mais detalhes ou solicitar novamente.</p>
      </div>
    `,
  };
}
