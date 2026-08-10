// Contrato comum entre provedores de e-mail. A rota que envia um código de verificação
// não deve saber se por baixo é SMTP ou Microsoft Graph — só precisa do resultado
// estruturado abaixo para decidir se pode dizer "enviado" ao usuário.
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

// "success" aqui significa apenas "o provedor aceitou a mensagem para envio" — nunca
// "o destinatário recebeu". A distinção importa: um SMTP que responde 250 OK ou um Graph
// que responde 202 Accepted confirmam que a mensagem entrou na fila de saída do provedor,
// não que ela passou pelo antispam do lado de quem recebe. `accepted`/`rejected` vêm do
// próprio provedor quando disponíveis (nodemailer expõe os dois; Graph não expõe nada
// equivalente por chamada, e nesse caso `accepted` é inferido do sucesso da chamada REST).
export interface EmailSendResult {
  success: boolean;
  provider: "smtp" | "graph";
  messageId?: string;
  accepted: string[];
  rejected: string[];
  response?: string;
  errorCode?: string;
  tempoMs: number;
}

export class EmailNaoEnviadoError extends Error {
  readonly causaOriginal?: unknown;
  readonly errorCode: string;
  constructor(mensagem: string, errorCode: string, causaOriginal?: unknown) {
    super(mensagem);
    this.name = "EmailNaoEnviadoError";
    this.errorCode = errorCode;
    this.causaOriginal = causaOriginal;
  }
}

export interface EmailProvider {
  readonly nome: "smtp" | "graph";
  // Lança se a configuração obrigatória do provedor estiver ausente/inválida — chamado no
  // boot para falhar alto e claro em vez de deixar a aplicação subir com envio quebrado.
  validarConfiguracao(): void;
  // Verificação de conectividade best-effort (ex.: SMTP `verify()`). Nunca lança — erros
  // viram log; é diagnóstico, não deve derrubar o boot por uma falha de rede passageira.
  testarConexao(): Promise<{ ok: boolean; detalhe?: string }>;
  enviar(mensagem: EmailMessage): Promise<EmailSendResult>;
}
