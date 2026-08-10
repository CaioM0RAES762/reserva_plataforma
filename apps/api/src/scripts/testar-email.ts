import "dotenv/config";
import {
  emailConfigurado,
  enviarEmail,
  provedorEmailAtivo,
  templateCodigoVerificacao,
  testarConexaoEmail,
} from "../services/email.service.js";
import { gerarCodigoVerificacao } from "../utils/password.js";

// Diagnóstico do envio de e-mail, isolado do resto da aplicação.
//
// Uso: pnpm --filter @plataformares/api email:diagnose destinatario@metalsider.com.br
//
// IMPORTANTE — o que este script NÃO prova: um "aceito pelo provedor" aqui confirma só que
// o SMTP/Graph recebeu a mensagem para envio, não que ela chegou na caixa de entrada do
// destinatário. É uma ferramenta auxiliar para isolar problema de credencial/configuração
// do resto da cadeia — não substitui testar o fluxo real pela aplicação (criar usuário,
// clicar em "Reenviar código", etc.), que é o que efetivamente prova entrega ponta a ponta.
const VARIAVEIS_SMTP = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_HOST", "EMAIL_PORT", "EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_FROM", "EMAIL_FROM_NAME"] as const;
const VARIAVEIS_GRAPH = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_SENDER", "GRAPH_SENDER_EMAIL"] as const;

function imprimirGrupo(titulo: string, nomes: readonly string[]): void {
  console.log(`\n${titulo}:`);
  for (const nome of nomes) {
    const valor = process.env[nome];
    // Segredos nunca são impressos — só se estão presentes.
    const exibicao = /PASSWORD|SECRET|PASS/.test(nome) ? (valor ? "(definida)" : "") : (valor ?? "");
    console.log(`  ${valor ? "OK    " : "FALTA "} ${nome}${exibicao ? ` = ${exibicao}` : ""}`);
  }
}

async function main() {
  const destinatario = process.argv[2];
  if (!destinatario) {
    console.error("Informe o destinatário: pnpm --filter @plataformares/api email:diagnose nome@metalsider.com.br");
    process.exit(1);
  }

  console.log(`environment=${process.env.NODE_ENV ?? "development"} cwd=${process.cwd()}`);
  imprimirGrupo("SMTP", VARIAVEIS_SMTP);
  imprimirGrupo("Microsoft Graph", VARIAVEIS_GRAPH);
  imprimirGrupo("Provedor explícito", ["EMAIL_PROVIDER"]);

  const provedor = provedorEmailAtivo();
  console.log(`\nProvedor resolvido: ${provedor ?? "nenhum"}`);

  if (!emailConfigurado()) {
    console.error(
      "\nEnvio indisponível. Defina EMAIL_PROVIDER + as variáveis correspondentes (SMTP_*/EMAIL_* ou GRAPH_*) em apps/api/.env.\n" +
        "Enquanto isso, em desenvolvimento os e-mails são gravados em apps/api/emails-dev/."
    );
    process.exit(1);
  }

  console.log("\nVerificando conectividade com o provedor...");
  const conexao = await testarConexaoEmail();
  console.log(`  conexão: ${conexao.ok ? "OK" : `FALHA — ${conexao.detalhe}`}`);
  if (!conexao.ok) {
    console.error("\nA conexão falhou antes mesmo de tentar enviar — corrija isto primeiro.");
    process.exit(1);
  }

  const { assunto, corpoHtml, corpoTexto } = templateCodigoVerificacao(gerarCodigoVerificacao(), "ativacao_conta");
  console.log(`\nEnviando mensagem de teste para ${destinatario}...`);
  try {
    const resultado = await enviarEmail(
      { destinatario, assunto, corpoHtml, corpoTexto },
      { tipo: "NOTIFICATION" }
    );
    console.log("\nResultado estruturado:");
    console.log(`  success     = ${resultado.success}`);
    console.log(`  provider    = ${resultado.provider}`);
    console.log(`  messageId   = ${resultado.messageId ?? "-"}`);
    console.log(`  accepted    = ${JSON.stringify(resultado.accepted)}`);
    console.log(`  rejected    = ${JSON.stringify(resultado.rejected)}`);
    console.log(`  response    = ${resultado.response ?? "-"}`);
    console.log(`  tempoMs     = ${resultado.tempoMs}`);
    console.log(
      "\nO provedor aceitou a mensagem. Isso NÃO garante entrega — verifique a caixa de entrada e o " +
        "lixo eletrônico do destinatário. Se nunca chegar (nem no spam), o próximo suspeito é o filtro " +
        "antiphishing do lado do destinatário (Microsoft Defender/Exchange Online), não este script."
    );
    process.exit(0);
  } catch (err) {
    const causa = err instanceof Error ? ((err as { causaOriginal?: unknown }).causaOriginal ?? err) : err;
    const codigo = err instanceof Error ? (err as { errorCode?: string }).errorCode : undefined;
    console.error(`\nFalha no envio. Código: ${codigo ?? "desconhecido"}`);
    console.error("Resposta original do provedor:");
    console.error(causa);
    console.error(
      "\nCausas comuns (SMTP):\n" +
        "  - senha de app inválida/revogada (Gmail exige senha de app, não a senha normal);\n" +
        "  - verificação em duas etapas desativada na conta remetente;\n" +
        "  - porta e SMTP_SECURE incompatíveis (587 ⇒ false, 465 ⇒ true);\n" +
        "  - saída SMTP bloqueada pela rede/firewall.\n" +
        "\nCausas comuns (Graph):\n" +
        "  - permissão de APLICAÇÃO Mail.Send sem consentimento do administrador do tenant;\n" +
        "  - GRAPH_SENDER não é caixa real e licenciada do tenant;\n" +
        "  - client secret expirado."
    );
    process.exit(1);
  }
}

main();
