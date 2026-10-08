import type { FastifyInstance } from "fastify";
import {
  atualizarConfiguracoesSchema,
  horaParaMinutos,
  type AtualizarConfiguracoesInput,
  type ChaveConfiguracao,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import {
  invalidarCacheConfiguracao,
  lerHorariosExpedienteGravados,
  listarConfiguracoes,
  obterRegrasAgendaPublicas,
  salvarConfiguracoes,
  type ConfiguracaoListada,
} from "../services/configuracao.service.js";
import { publicarEventoGlobal } from "../services/eventos.service.js";

const CAMPO_PARA_CHAVE: Record<keyof AtualizarConfiguracoesInput, ChaveConfiguracao> = {
  antecedenciaMinimaHoras: "antecedencia_minima_horas",
  duracaoMaximaHoras: "duracao_maxima_horas",
  maxPendentesPorSetor: "max_pendentes_por_setor",
  horarioExpedienteInicio: "horario_expediente_inicio",
  horarioExpedienteFim: "horario_expediente_fim",
  slaAprovacaoUrgenteHoras: "sla_aprovacao_urgente_horas",
  modoAprovacaoReservas: "modo_aprovacao_reservas",
  politicaSubstituicaoReservaUrgente: "politica_substituicao_reserva_urgente",
};

function mapConfiguracao(item: ConfiguracaoListada) {
  return {
    chave: item.chave,
    valor: item.valor,
    descricao: item.descricao,
    atualizadoEm: item.atualizadoEm,
    atualizadoPorId: item.atualizadoPorId,
  };
}

// RF-CFG-01/02 (S12): Admin parametriza as regras de agendamento (antecedência mínima,
// duração máxima, limite de pendentes por setor, horário de expediente) e o SLA de
// aprovação urgente (RN-RES-09, já existente desde S7) — tudo sobre ConfiguracaoSistema
// (criada em S7). Nenhuma outra rota do sistema escreve nesta tabela.
export async function configuracoesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/configuracoes",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (_request, reply) => {
      const linhas = await listarConfiguracoes();
      return reply.status(200).send(linhas.map(mapConfiguracao));
    }
  );

  // Regras de agenda para QUALQUER perfil autenticado. GET /configuracoes é exclusivo do Admin
  // (lista todas as chaves, com metadados), então Calendário e Nova Reserva de Colaborador/
  // Gestor não tinham como saber o expediente e desenhavam uma grade fixa. Esta projeção
  // pequena vem do mesmo cache/fonte que a validação de POST /reservas.
  app.get("/api/v1/configuracoes/regras-reserva", { preHandler: autenticar }, async (_request, reply) => {
    const regras = await obterRegrasAgendaPublicas();
    // no-store: o expediente pode mudar a qualquer momento pelo Admin, e um cache de
    // navegador/proxy faria a grade mostrar horário que a criação já não aceita.
    return reply.header("Cache-Control", "no-store").status(200).send(regras);
  });

  app.put(
    "/api/v1/configuracoes",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = atualizarConfiguracoesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }

      const valoresParaSalvar: Partial<Record<ChaveConfiguracao, string>> = {};
      for (const [campo, valor] of Object.entries(parsed.data)) {
        const chave = CAMPO_PARA_CHAVE[campo as keyof AtualizarConfiguracoesInput];
        valoresParaSalvar[chave] = String(valor);
      }

      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        // O schema só compara início/fim quando os DOIS vêm no corpo. Enviando apenas um, o
        // outro é o valor já gravado — sem esta checagem dava para inverter o expediente
        // (ex.: início 23:00 com fim gravado 22:00) e toda reserva ficaria "fora do expediente".
        const enviouInicio = parsed.data.horarioExpedienteInicio !== undefined;
        const enviouFim = parsed.data.horarioExpedienteFim !== undefined;
        if (enviouInicio || enviouFim) {
          const gravados = await lerHorariosExpedienteGravados(transaction);
          const inicio = parsed.data.horarioExpedienteInicio ?? gravados.inicio;
          const fim = parsed.data.horarioExpedienteFim ?? gravados.fim;
          if (horaParaMinutos(fim) <= horaParaMinutos(inicio)) {
            await transaction.rollback();
            const campo = enviouFim ? "horarioExpedienteFim" : "horarioExpedienteInicio";
            const mensagem = enviouFim
              ? enviouInicio
                ? "O horário de fim do expediente deve ser após o horário de início."
                : `O horário de fim do expediente deve ser após o início já configurado (${inicio}).`
              : `O horário de início do expediente deve ser antes do fim já configurado (${fim}).`;
            return reply.status(422).send({
              erro: "Dados inválidos.",
              detalhes: { formErrors: [], fieldErrors: { [campo]: [mensagem] } },
            });
          }
        }

        // Modo de aprovação ganha evento PRÓPRIO quando muda (de → para): é uma decisão de
        // política, não um ajuste numérico. Lido com UPDLOCK antes da escrita.
        let modoAnterior: string | null = null;
        if (parsed.data.modoAprovacaoReservas !== undefined) {
          const atual = await transaction
            .request()
            .query<{ valor: string }>(
              "SELECT valor FROM ConfiguracaoSistema WITH (UPDLOCK, ROWLOCK) WHERE chave = 'modo_aprovacao_reservas'"
            );
          modoAnterior = atual.recordset[0]?.valor ?? "manual";
        }

        // Política de substituição por urgência: mesma lógica do modo de aprovação — evento
        // próprio (de → para) quando muda, lido com UPDLOCK antes da escrita.
        let politicaAnterior: string | null = null;
        if (parsed.data.politicaSubstituicaoReservaUrgente !== undefined) {
          const atual = await transaction
            .request()
            .query<{ valor: string }>(
              "SELECT valor FROM ConfiguracaoSistema WITH (UPDLOCK, ROWLOCK) WHERE chave = 'politica_substituicao_reserva_urgente'"
            );
          politicaAnterior = atual.recordset[0]?.valor ?? "todos_aprovadores";
        }

        await salvarConfiguracoes(transaction, valoresParaSalvar, request.usuario!.sub);
        if (politicaAnterior !== null && politicaAnterior !== parsed.data.politicaSubstituicaoReservaUrgente) {
          await transaction
            .request()
            .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
            .input(
              "detalhes",
              sql.NVarChar,
              JSON.stringify({
                politicaAnterior,
                politicaNova: parsed.data.politicaSubstituicaoReservaUrgente,
              })
            )
            .query(
              `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
               VALUES (@usuario_id, 'alterar_politica_substituicao_urgente', 'ConfiguracaoSistema', NULL, @detalhes)`
            );
        }
        if (modoAnterior !== null && modoAnterior !== parsed.data.modoAprovacaoReservas) {
          await transaction
            .request()
            .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
            .input(
              "detalhes",
              sql.NVarChar,
              JSON.stringify({ modoAnterior, modoNovo: parsed.data.modoAprovacaoReservas })
            )
            .query(
              `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
               VALUES (@usuario_id, 'alterar_modo_aprovacao', 'ConfiguracaoSistema', NULL, @detalhes)`
            );
        }
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("acao", sql.VarChar, "atualizar_configuracao")
          .input("detalhes", sql.NVarChar, JSON.stringify(valoresParaSalvar))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, @acao, 'ConfiguracaoSistema', NULL, @detalhes)`
          );
        await transaction.commit();
      } catch (err) {
        // Pode já ter sido revertida no ramo de 422 acima; rollback numa transação encerrada
        // lançaria um erro que mascararia a causa original.
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      // salvarConfiguracoes invalida o cache ainda DENTRO da transação: uma leitura que
      // chegasse entre a invalidação e o commit repovoaria o cache com o valor antigo (sob
      // isolamento por versão de linha), e ele ficaria assim até o próximo PUT. Invalidar de
      // novo depois do commit fecha essa janela — e é o que garante que a releitura disparada
      // pelo evento abaixo já enxergue o valor novo.
      invalidarCacheConfiguracao();

      // Calendários e formulários abertos (de qualquer perfil) rebuscam as regras sozinhos.
      // Fora da transação e best-effort: falhar em avisar nunca desfaz a configuração salva.
      try {
        publicarEventoGlobal("configuracao.atualizada", { chaves: Object.keys(valoresParaSalvar) });
      } catch {
        // sem clientes SSE conectados / socket já encerrado — o próximo carregamento lê o valor novo
      }

      const linhas = await listarConfiguracoes();
      return reply.status(200).send(linhas.map(mapConfiguracao));
    }
  );
}
