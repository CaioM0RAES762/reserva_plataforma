import "dotenv/config";
import { buildApp } from "./app.js";
import { closePool } from "./db/pool.js";
import { encerrarBrowserRelatorios } from "./services/relatorioExport.service.js";
import {
  agendarAutomacaoRepetitiva,
  iniciarAutomacaoWorker,
  iniciarEmailWorker,
  removerJobsLegadosDeEscalonamento,
} from "./services/queue.js";
import { logConfiguracaoEmail, testarConexaoEmail, validarConfiguracaoEmailNoBoot } from "./services/email.service.js";
import { prepararArmazenamento } from "./services/storage.service.js";

async function main() {
  // Falha alto e claro ANTES de abrir a porta: se EMAIL_PROVIDER foi declarado
  // explicitamente e a configuração obrigatória daquele provedor está incompleta, subir a
  // API mesmo assim só adiaria o erro para o primeiro usuário que tentasse ativar a conta
  // — e ele veria "código enviado" sem nenhum e-mail sair. Sem EMAIL_PROVIDER declarado,
  // isto não lança (comportamento de desenvolvimento é preservado).
  validarConfiguracaoEmailNoBoot();

  const app = await buildApp();
  const port = Number(process.env.API_PORT ?? 3333);

  iniciarEmailWorker();

  // Ambientes que rodavam a versão anterior têm o job repetitivo de escalonação de SLA
  // gravado no Redis. Sem worker, ele ficaria acumulando execuções pendentes para sempre.
  await removerJobsLegadosDeEscalonamento();

  // Início/finalização automática de reservas no horário agendado. Com o fim do fluxo de
  // aprovação este worker passou a ser o motor do ciclo de vida da reserva — roda no
  // servidor, não depende de nenhum navegador aberto.
  iniciarAutomacaoWorker();
  await agendarAutomacaoRepetitiva();

  // "Editei o .env" e "o processo que atende as requisições está usando esse .env" são
  // afirmações diferentes — múltiplas instâncias, cwd errado ou um processo antigo ainda
  // vivo bastam para divergir. Este log mostra a configuração REAL resolvida por este
  // processo específico, mascarada (nunca a senha/secret).
  logConfiguracaoEmail(app.log);

  // Diagnóstico de conectividade best-effort — não bloqueia o boot (uma rede instável no
  // instante do deploy não deveria impedir a API de subir), mas fica registrado se o
  // provedor configurado nem consegue autenticar/conectar.
  testarConexaoEmail()
    .then((resultado) => {
      if (resultado.ok) {
        app.log.info({ provider: resultado.provider }, "[EMAIL CONFIG] conexão com o provedor verificada com sucesso");
      } else {
        app.log.warn({ provider: resultado.provider, detalhe: resultado.detalhe }, "[EMAIL CONFIG] falha ao verificar conexão com o provedor no boot");
      }
    })
    .catch(() => undefined);

  // Armazenamento local de uploads (STORAGE_ROOT): cria a pasta se ainda não existir e confere
  // permissão de escrita. Best-effort — um problema aqui aparece no log do boot, em vez de só
  // no primeiro upload de um usuário.
  prepararArmazenamento()
    .then((resultado) => {
      if (resultado.ok) {
        app.log.info({ raiz: resultado.raiz }, "[STORAGE] pasta de arquivos pronta");
      } else {
        app.log.warn(
          { raiz: resultado.raiz, detalhe: resultado.detalhe },
          "[STORAGE] pasta de arquivos sem permissão de leitura/escrita — uploads vão falhar até isso ser corrigido"
        );
      }
    })
    .catch(() => undefined);

  await app.listen({ port, host: "0.0.0.0" });

  // Desligamento gracioso — não existia. Ao reiniciar/derrubar a API (deploy, `docker
  // stop`, Ctrl+C), o processo morria de imediato: requisições em andamento eram cortadas
  // no meio, conexões do pool do SQL Server ficavam penduradas até o timeout do servidor,
  // e o Chromium do Puppeteer sobrevivia como processo órfão a cada ciclo.
  let encerrando = false;
  async function encerrar(sinal: string) {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ sinal }, "encerrando aplicação");
    try {
      // Ordem importa: para de aceitar requisições novas e espera as em curso terminarem
      // antes de fechar os recursos que elas usam.
      await app.close();
      await Promise.allSettled([closePool(), encerrarBrowserRelatorios()]);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "falha no encerramento gracioso");
      process.exit(1);
    }
  }

  for (const sinal of ["SIGTERM", "SIGINT"] as const) {
    process.on(sinal, () => void encerrar(sinal));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
