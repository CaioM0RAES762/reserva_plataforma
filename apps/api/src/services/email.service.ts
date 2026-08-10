import "dotenv/config";
import { EmailNaoEnviadoError, type EmailProvider, type EmailSendResult } from "./email/types.js";
import { SmtpEmailProvider, lerConfigSmtpDoAmbiente, type SmtpConfig } from "./email/smtpProvider.js";
import { MicrosoftGraphEmailProvider, lerConfigGraphDoAmbiente, type GraphConfig } from "./email/graphProvider.js";

export { EmailNaoEnviadoError, type EmailSendResult } from "./email/types.js";

// Compatibilidade com o formato usado pela fila (BullMQ) e pelas ~10 rotas que só chamam
// `enviarEmail`/`enfileirarEmail` sem se importar com o resultado estruturado.
export interface EmailJobData {
  destinatario: string;
  assunto: string;
  corpoHtml: string;
  // Alternativa texto puro. Quando ausente, é derivada do HTML (ver `htmlParaTexto`) — os
  // templates de código de verificação (auth) já fornecem uma versão escrita à mão, mais
  // legível que a derivação automática.
  corpoTexto?: string;
}

const isProduction = process.env.NODE_ENV === "production";

export type ProvedorEmail = "smtp" | "graph";

// Fora de produção, sem provedor configurado, o e-mail é gravado em disco em vez de
// enviado — assim o fluxo de ativação/recuperação é testável ponta a ponta localmente sem
// credenciais reais. Em produção isto nunca é usado: sem credenciais o envio falha
// explicitamente (ver `enviarEmail`).
const DIRETORIO_EMAILS_DEV = "emails-dev";

async function registrarEmailEmDisco(data: EmailJobData): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(DIRETORIO_EMAILS_DEV, { recursive: true });
  const arquivo = join(
    DIRETORIO_EMAILS_DEV,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${data.destinatario.replace(/[^a-z0-9]/gi, "_")}.html`
  );
  await writeFile(arquivo, `<!-- ${data.assunto} -->\n${data.corpoHtml}`, "utf8");
  return arquivo;
}

// Remove tags e normaliza espaços para gerar a alternativa text/plain de templates que não
// escrevem a própria versão em texto. Filtros antispam pontuam negativamente mensagens
// só-HTML sem contraparte em texto puro.
function htmlParaTexto(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((linha) => linha.trim())
    .join("\n")
    .trim();
}

function mascararEmail(email: string): string {
  const [usuario, dominio] = email.split("@");
  if (!dominio) return "***";
  const visivel = usuario.slice(0, 2);
  return `${visivel}${"*".repeat(Math.max(usuario.length - 2, 1))}@${dominio}`;
}

// ---------------------------------------------------------------------------------------
// Resolução de provedor
// ---------------------------------------------------------------------------------------
//
// EMAIL_PROVIDER explícito ("smtp" | "graph") tem precedência e é validado no boot: se
// declarado e a configuração obrigatória daquele provedor estiver incompleta, a aplicação
// falha alto e claro (`validarConfiguracaoEmailNoBoot`) em vez de subir silenciosamente
// quebrada. Sem EMAIL_PROVIDER, o comportamento antigo é preservado: autodetecta por
// credenciais presentes (SMTP tem precedência sobre Graph), e sem nenhuma credencial cai
// no fallback de disco em desenvolvimento.
function providerExplicito(): ProvedorEmail | null {
  const valor = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!valor) return null;
  if (valor === "smtp" || valor === "graph") return valor;
  throw new Error(`EMAIL_PROVIDER inválido: "${valor}". Valores aceitos: "smtp" ou "graph".`);
}

export function credenciaisSmtpConfiguradas(): boolean {
  return lerConfigSmtpDoAmbiente() !== null;
}

export function credenciaisGraphConfiguradas(): boolean {
  return lerConfigGraphDoAmbiente() !== null;
}

export function provedorEmailAtivo(): ProvedorEmail | null {
  const explicito = providerExplicito();
  if (explicito) return explicito;
  if (credenciaisSmtpConfiguradas()) return "smtp";
  if (credenciaisGraphConfiguradas()) return "graph";
  return null;
}

export function emailConfigurado(): boolean {
  return provedorEmailAtivo() !== null;
}

let providerInstance: EmailProvider | null = null;
let providerInstanceKey: string | null = null;
let providerOverrideParaTeste: EmailProvider | null = null;

// Seam de injeção de dependência só para testes: permite que testes unitários/integração
// substituam o provedor real por um mock (sem rede, sem SMTP/Graph reais) e ainda assim
// exercitem a lógica de negócio de verdade (rate limit, transação, resposta HTTP). Nunca
// usado em código de produção — nenhuma rota chama isto.
export function definirProviderEmailParaTeste(provider: EmailProvider | null): void {
  providerOverrideParaTeste = provider;
  providerInstance = null;
  providerInstanceKey = null;
}

function resolverProvider(): EmailProvider | null {
  if (providerOverrideParaTeste) return providerOverrideParaTeste;

  const provedor = provedorEmailAtivo();
  if (!provedor) return null;

  // Recria a instância só se a escolha de provedor mudou (relevante em testes, que trocam
  // variáveis de ambiente entre casos) — o transporte SMTP em si já mantém pool próprio.
  const chave = provedor;
  if (providerInstance && providerInstanceKey === chave) return providerInstance;

  providerInstance =
    provedor === "smtp"
      ? new SmtpEmailProvider(lerConfigSmtpDoAmbiente())
      : new MicrosoftGraphEmailProvider(lerConfigGraphDoAmbiente());
  providerInstanceKey = chave;
  return providerInstance;
}

// Chamado uma vez no boot (server.ts). Só lança quando EMAIL_PROVIDER foi declarado
// explicitamente e a configuração obrigatória daquele provedor está incompleta — nunca por
// simplesmente não haver nenhum provedor configurado em desenvolvimento (fallback de disco
// continua válido nesse caso).
export function validarConfiguracaoEmailNoBoot(): void {
  const explicito = providerExplicito(); // lança se EMAIL_PROVIDER tiver valor inválido
  if (!explicito) return;

  const provider = explicito === "smtp" ? new SmtpEmailProvider(lerConfigSmtpDoAmbiente()) : new MicrosoftGraphEmailProvider(lerConfigGraphDoAmbiente());
  provider.validarConfiguracao();
}

// Log mascarado da configuração real resolvida pelo processo em execução — nunca imprime
// senha/secret. Existe porque "editei o .env" e "o processo que atende as requisições usa
// esse .env" são afirmações diferentes: múltiplas instâncias, cwd errado, ou um processo
// antigo ainda vivo fazem o processo real rodar com config diferente da que se imagina.
// Ver README/relatório: isto é o que se deve olhar para confirmar qual config está ativa.
export function logConfiguracaoEmail(logger: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void }): void {
  const provedor = provedorEmailAtivo();
  const smtp = lerConfigSmtpDoAmbiente();
  const graph = lerConfigGraphDoAmbiente();

  const info: Record<string, unknown> = {
    provider: provedor ?? "nenhum (fallback: grava em disco fora de produção)",
    environment: process.env.NODE_ENV ?? "development",
    cwd: process.cwd(),
  };
  if (smtp) {
    info.smtp = { host: smtp.host, port: smtp.port, secure: smtp.secure, user: maskUser(smtp.user), from: smtp.from };
  }
  if (graph) {
    info.graph = { tenantId: graph.tenantId, senderEmail: maskUser(graph.senderEmail) };
  }

  if (!provedor && isProduction) {
    logger.warn(info, "[EMAIL CONFIG] nenhum provedor configurado em produção — códigos de verificação NÃO serão entregues");
  } else {
    logger.info(info, "[EMAIL CONFIG]");
  }
}

function maskUser(endereco: string): string {
  const [usuario, dominio] = endereco.split("@");
  if (!dominio) return "***";
  return `${usuario.slice(0, 1)}***@${dominio}`;
}

// Diagnóstico de conectividade (usado pelo script `email:diagnose` e, opcionalmente, no
// boot). Nunca lança: o resultado é sempre `{ok, detalhe?}`.
export async function testarConexaoEmail(): Promise<{ ok: boolean; provider: ProvedorEmail | null; detalhe?: string }> {
  const provider = resolverProvider();
  if (!provider) return { ok: false, provider: null, detalhe: "Nenhum provedor configurado." };
  const resultado = await provider.testarConexao();
  return { ...resultado, provider: provider.nome };
}

// ---------------------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------------------

export type TipoEmailObservabilidade =
  | "ACTIVATION"
  | "ACTIVATION_RESEND"
  | "PASSWORD_RESET"
  | "NOTIFICATION";

export interface EnviarEmailOpcoes {
  tipo?: TipoEmailObservabilidade;
  correlationId?: string;
}

// Ponto único de envio. Sempre retorna o resultado estruturado do provedor em caso de
// sucesso; sempre lança `EmailNaoEnviadoError` em caso de falha — nunca engole o erro e
// finge sucesso. Quem chama decide o que responder ao cliente (rotas de auth precisam
// diferenciar "não vou revelar se a conta existe" de "o envio realmente falhou"; a fila de
// notificações em massa só precisa que a exceção dispare o retry do BullMQ).
export async function enviarEmail(data: EmailJobData, opcoes: EnviarEmailOpcoes = {}): Promise<EmailSendResult> {
  const tipo = opcoes.tipo ?? "NOTIFICATION";
  const destinatarioMascarado = mascararEmail(data.destinatario);
  const logPrefixo = opcoes.correlationId ? `[EMAIL][${opcoes.correlationId}]` : "[EMAIL]";

  console.info(`${logPrefixo} tentativa iniciada tipo=${tipo} destinatario=${destinatarioMascarado}`);

  const provider = resolverProvider();
  if (!provider) {
    if (isProduction) {
      console.error(`${logPrefixo} erro tipo=${tipo} destinatario=${destinatarioMascarado} codigo=NO_PROVIDER_IN_PRODUCTION`);
      throw new EmailNaoEnviadoError(
        "Provedor de e-mail não configurado (defina EMAIL_PROVIDER + as variáveis correspondentes).",
        "NO_PROVIDER_IN_PRODUCTION"
      );
    }
    const arquivo = await registrarEmailEmDisco(data);
    console.warn(
      `${logPrefixo} nenhum provedor configurado — gravado em disco tipo=${tipo} destinatario=${destinatarioMascarado} arquivo=${arquivo} (modo desenvolvimento)`
    );
    return {
      success: true,
      provider: "smtp",
      accepted: [data.destinatario],
      rejected: [],
      response: `dev-fallback:${arquivo}`,
      tempoMs: 0,
    };
  }

  console.info(`${logPrefixo} provider utilizado=${provider.nome} tipo=${tipo}`);

  try {
    const resultado = await provider.enviar({
      to: data.destinatario,
      subject: data.assunto,
      html: data.corpoHtml,
      text: data.corpoTexto ?? htmlParaTexto(data.corpoHtml),
    });
    console.info(
      `${logPrefixo} aceito tipo=${tipo} destinatario=${destinatarioMascarado} provider=${resultado.provider} ` +
        `messageId=${resultado.messageId ?? "-"} accepted=${resultado.accepted.length} rejected=${resultado.rejected.length} ` +
        `tempoMs=${resultado.tempoMs} response="${resultado.response ?? ""}"`
    );
    return resultado;
  } catch (err) {
    const erro = err instanceof EmailNaoEnviadoError ? err : new EmailNaoEnviadoError("Falha ao enviar e-mail.", "UNKNOWN", err);
    console.error(
      `${logPrefixo} rejeitado/erro tipo=${tipo} destinatario=${destinatarioMascarado} provider=${provider.nome} codigo=${erro.errorCode} mensagem="${erro.message}"`
    );
    throw erro;
  }
}

export function templateCodigoVerificacao(codigo: string, tipo: "ativacao_conta" | "reset_senha"): {
  assunto: string;
  corpoHtml: string;
  corpoTexto: string;
} {
  const titulo = tipo === "ativacao_conta" ? "Ativação de conta" : "Redefinição de senha";
  const assunto = `PlataformaRes — Código de verificação (${titulo})`;
  const corpoHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color:#1a1a1a;">
        <p style="font-size:13px; color:#666; letter-spacing:0.5px; text-transform:uppercase; margin:0 0 4px;">PlataformaRes</p>
        <h2 style="margin:0 0 12px;">${titulo}</h2>
        <p>Use o código abaixo para continuar. Ele expira em 15 minutos e só pode ser usado uma vez.</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">${codigo}</p>
        <p style="color: #666; font-size: 13px;">Se você não solicitou isso, ignore este e-mail — nenhuma ação será tomada na sua conta.</p>
      </div>
    `;
  const corpoTexto = [
    "PlataformaRes",
    titulo,
    "",
    "Use o código abaixo para continuar. Ele expira em 15 minutos e só pode ser usado uma vez.",
    "",
    `Código: ${codigo}`,
    "",
    "Se você não solicitou isso, ignore este e-mail — nenhuma ação será tomada na sua conta.",
  ].join("\n");

  return { assunto, corpoHtml, corpoTexto };
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
