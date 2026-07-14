import type { FastifyInstance } from "fastify";
import {
  atualizarConfiguracoesSchema,
  type AtualizarConfiguracoesInput,
  type ChaveConfiguracao,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { listarConfiguracoes, salvarConfiguracoes, type ConfiguracaoListada } from "../services/configuracao.service.js";

const CAMPO_PARA_CHAVE: Record<keyof AtualizarConfiguracoesInput, ChaveConfiguracao> = {
  antecedenciaMinimaHoras: "antecedencia_minima_horas",
  duracaoMaximaHoras: "duracao_maxima_horas",
  maxPendentesPorSetor: "max_pendentes_por_setor",
  horarioExpedienteInicio: "horario_expediente_inicio",
  horarioExpedienteFim: "horario_expediente_fim",
  slaAprovacaoUrgenteHoras: "sla_aprovacao_urgente_horas",
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
        await salvarConfiguracoes(transaction, valoresParaSalvar, request.usuario!.sub);
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
        await transaction.rollback();
        throw err;
      }

      const linhas = await listarConfiguracoes();
      return reply.status(200).send(linhas.map(mapConfiguracao));
    }
  );
}
