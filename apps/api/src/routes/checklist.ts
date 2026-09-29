import type { FastifyInstance } from "fastify";
import {
  criarChecklistItemTemplateSchema,
  criarChecklistTemplateSchema,
  editarChecklistItemTemplateSchema,
  editarChecklistTemplateSchema,
  preencherChecklistSchema,
  reordenarChecklistItensSchema,
  type CategoriaPlataforma,
  type ResultadoItemChecklist,
  type SituacaoChecklist,
  type StatusReserva,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import {
  calcularTodosConformes,
  ObservacaoObrigatoriaError,
  ItemObrigatorioNaoRespondidoError,
  resolverTemplateEfetivo,
  validarObservacoesObrigatorias,
  validarRespostasParaFinalizar,
  type ItemTemplateChecklist,
} from "../services/checklist.service.js";
import { estadoFinal } from "../services/reservaEstado.service.js";
import { armazenamentoService, urlDeLeitura } from "../services/storage.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateChecklistNaoConforme } from "../services/email.service.js";

interface ItemTemplateRow {
  id: string;
  template_id: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  bloqueia_aprovacao: boolean;
  ativo: boolean;
}

function mapItemTemplate(row: ItemTemplateRow) {
  return {
    id: row.id,
    templateId: row.template_id,
    descricao: row.descricao,
    ordem: row.ordem,
    obrigatorio: row.obrigatorio,
    bloqueiaAprovacao: row.bloqueia_aprovacao,
    ativo: row.ativo,
  };
}

interface TemplateRow {
  id: string;
  nome: string;
  descricao: string | null;
  categoria_plataforma: CategoriaPlataforma;
  ativo: boolean;
  total_questoes: number;
  total_plataformas_vinculadas: number;
}

function mapTemplate(row: TemplateRow) {
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao,
    categoriaPlataforma: row.categoria_plataforma,
    ativo: row.ativo,
    totalQuestoes: row.total_questoes,
    totalPlataformasVinculadas: row.total_plataformas_vinculadas,
  };
}

// Contagens resolvidas por subconsulta na mesma varredura ("6 questões · 3 plataformas
// vinculadas" na tela de gerenciamento) — nunca N+1 a partir do frontend.
const SELECT_TEMPLATE = `
  t.id, t.nome, t.descricao, t.categoria_plataforma, t.ativo,
  (SELECT COUNT(*) FROM ChecklistItemTemplate it WHERE it.template_id = t.id AND it.ativo = 1) AS total_questoes,
  (SELECT COUNT(*) FROM Plataforma p WHERE p.checklist_template_id = t.id AND p.exige_checklist = 1)
    AS total_plataformas_vinculadas`;

interface ReservaChecklistContexto {
  id: string;
  status: StatusReserva;
  setor_id: string;
  plataforma_id: string;
}

async function buscarContextoReservaChecklist(id: string): Promise<ReservaChecklistContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaChecklistContexto>(
      `SELECT r.id, r.status, r.setor_id, r.plataforma_id
       FROM Reserva r
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

interface RespostaGravada {
  resultado: ResultadoItemChecklist;
  observacao: string | null;
  foto_url: string | null;
  item_descricao: string | null;
  item_ordem: number | null;
  item_obrigatorio: boolean | null;
  item_bloqueia_aprovacao: boolean | null;
}

interface ItensERespostas {
  itens: ItemTemplateRow[];
  preenchidoId: string | null;
  finalizadoEm: Date | null;
  preenchidoPorNome: string | null;
  preenchidoEm: Date | null;
  respostasPorItem: Map<string, RespostaGravada>;
}

async function buscarItensERespostas(templateId: string, reservaId: string): Promise<ItensERespostas> {
  const pool = await getPool();
  const [templateResult, preenchidoResult] = await Promise.all([
    pool
      .request()
      .input("template_id", sql.UniqueIdentifier, templateId)
      .query<ItemTemplateRow>(
        `SELECT id, template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao, ativo
         FROM ChecklistItemTemplate WHERE template_id = @template_id AND ativo = 1 ORDER BY ordem`
      ),
    pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, reservaId)
      .query<
        RespostaGravada & {
          preenchido_id: string;
          finalizado_em: Date | null;
          preenchido_em: Date;
          preenchido_por_nome: string;
          item_id: string | null;
        }
      >(
        `SELECT cp.id AS preenchido_id, cp.finalizado_em, cp.preenchido_em, u.nome AS preenchido_por_nome,
                cr.item_id, cr.resultado, cr.observacao, cr.foto_url,
                cr.item_descricao, cr.item_ordem, cr.item_obrigatorio, cr.item_bloqueia_aprovacao
         FROM ChecklistPreenchido cp
         JOIN Usuario u ON u.id = cp.preenchido_por_id
         LEFT JOIN ChecklistResposta cr ON cr.checklist_preenchido_id = cp.id
         WHERE cp.reserva_id = @reserva_id`
      ),
  ]);

  const linhas = preenchidoResult.recordset;
  const cabecalho = linhas[0] ?? null;
  const respostasPorItem = new Map<string, RespostaGravada>(
    linhas
      .filter((l) => l.item_id !== null)
      .map((l) => [
        l.item_id as string,
        {
          resultado: l.resultado,
          observacao: l.observacao,
          foto_url: l.foto_url,
          item_descricao: l.item_descricao,
          item_ordem: l.item_ordem,
          item_obrigatorio: l.item_obrigatorio,
          item_bloqueia_aprovacao: l.item_bloqueia_aprovacao,
        },
      ])
  );

  return {
    itens: templateResult.recordset,
    preenchidoId: cabecalho?.preenchido_id ?? null,
    finalizadoEm: cabecalho?.finalizado_em ?? null,
    preenchidoPorNome: cabecalho?.preenchido_por_nome ?? null,
    preenchidoEm: cabecalho?.preenchido_em ?? null,
    respostasPorItem,
  };
}

export async function situacaoChecklistDe(params: {
  requerChecklist: boolean;
  finalizadoEm: Date | null;
  totalItens: number;
  totalRespondidos: number;
  todosConformes: boolean | null;
}): Promise<SituacaoChecklist | null> {
  if (!params.requerChecklist) return null;
  if (params.finalizadoEm) {
    return params.todosConformes ? "concluido" : "nao_conforme";
  }
  if (params.totalRespondidos > 0) return "em_preenchimento";
  return "pendente";
}

export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  // ===========================================================================
  // Administração de templates — "Gerenciar templates" (área Checklists) e o
  // seletor/atalho da seção Segurança no cadastro da Frota consomem estas mesmas rotas.
  // Um único sistema de edição, usado pelas duas telas.
  // ===========================================================================

  // Leitura liberada a qualquer perfil autenticado: o modal de preenchimento e a tela de
  // Frota precisam listar templates. A escrita continua restrita a Admin.
  app.get("/api/v1/checklist-modelos", { preHandler: autenticar }, async (request, reply) => {
    const { incluirInativos } = request.query as { incluirInativos?: string };
    const pool = await getPool();
    const result = await pool
      .request()
      .query<TemplateRow>(
        `SELECT ${SELECT_TEMPLATE} FROM ChecklistTemplate t
         ${incluirInativos === "true" ? "" : "WHERE t.ativo = 1"}
         ORDER BY t.ativo DESC, t.nome ASC`
      );
    return reply.status(200).send(result.recordset.map(mapTemplate));
  });

  app.get("/api/v1/checklist-modelos/:id", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = await getPool();
    const [templateResult, itensResult] = await Promise.all([
      pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<TemplateRow>(`SELECT ${SELECT_TEMPLATE} FROM ChecklistTemplate t WHERE t.id = @id`),
      pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ItemTemplateRow>(
          `SELECT id, template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao, ativo
           FROM ChecklistItemTemplate WHERE template_id = @id AND ativo = 1 ORDER BY ordem`
        ),
    ]);
    const template = templateResult.recordset[0];
    if (!template) {
      return reply.status(404).send({ erro: "Template de checklist não encontrado." });
    }
    return reply.status(200).send({
      ...mapTemplate(template),
      itens: itensResult.recordset.map(mapItemTemplate),
    });
  });

  app.post(
    "/api/v1/checklist-modelos",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarChecklistTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, descricao, categoriaPlataforma } = parsed.data;
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("nome", sql.NVarChar, nome)
          .input("descricao", sql.NVarChar, descricao ?? null)
          .input("categoria", sql.VarChar, categoriaPlataforma)
          .query<{ id: string }>(
            `INSERT INTO ChecklistTemplate (nome, descricao, categoria_plataforma)
             OUTPUT INSERTED.id
             VALUES (@nome, @descricao, @categoria)`
          );
        const novoId = insercao.recordset[0].id;

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, novoId)
          .input("detalhes", sql.NVarChar, JSON.stringify({ nome, categoriaPlataforma }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'criar_checklist_template', 'ChecklistTemplate', @entidade_id, @detalhes)`
          );
        await transaction.commit();

        const completo = await pool
          .request()
          .input("id", sql.UniqueIdentifier, novoId)
          .query<TemplateRow>(`SELECT ${SELECT_TEMPLATE} FROM ChecklistTemplate t WHERE t.id = @id`);
        return reply.status(201).send({ ...mapTemplate(completo.recordset[0]), itens: [] });
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/checklist-modelos/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = editarChecklistTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { nome, descricao, categoriaPlataforma, ativo } = parsed.data;
      const pool = await getPool();

      // Desativar um template que alguma plataforma ainda exige deixaria essa plataforma
      // num estado impossível: exige checklist, mas não há template ativo para resolver —
      // toda reserva dela travaria na aprovação sem que houvesse o que preencher.
      if (!ativo) {
        const vinculadas = await pool
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ total: number }>(
            `SELECT COUNT(*) AS total FROM Plataforma
             WHERE checklist_template_id = @id AND exige_checklist = 1`
          );
        if (vinculadas.recordset[0].total > 0) {
          return reply.status(409).send({
            erro: `Este template está em uso por ${vinculadas.recordset[0].total} plataforma(s). Troque o template dessas plataformas (ou desmarque "exige checklist") antes de desativá-lo.`,
          });
        }
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("nome", sql.NVarChar, nome)
          .input("descricao", sql.NVarChar, descricao ?? null)
          .input("categoria", sql.VarChar, categoriaPlataforma)
          .input("ativo", sql.Bit, ativo)
          .query<{ id: string }>(
            `UPDATE ChecklistTemplate
             SET nome = @nome, descricao = @descricao, categoria_plataforma = @categoria, ativo = @ativo
             OUTPUT INSERTED.id
             WHERE id = @id`
          );
        if (atualizacao.recordset.length === 0) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Template de checklist não encontrado." });
        }

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, id)
          .input("detalhes", sql.NVarChar, JSON.stringify({ nome, categoriaPlataforma, ativo }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'editar_checklist_template', 'ChecklistTemplate', @entidade_id, @detalhes)`
          );
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      const completo = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<TemplateRow>(`SELECT ${SELECT_TEMPLATE} FROM ChecklistTemplate t WHERE t.id = @id`);
      return reply.status(200).send(mapTemplate(completo.recordset[0]));
    }
  );

  // Adicionar questão. `ordem` omitida = vai para o fim da lista, calculado no banco para
  // não depender de o cliente conhecer a ordem atual.
  app.post(
    "/api/v1/checklist-modelos/:id/itens",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = criarChecklistItemTemplateSchema.safeParse({ ...(request.body as object), templateId: id });
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { descricao, ordem, obrigatorio, bloqueiaAprovacao } = parsed.data;
      const pool = await getPool();

      const template = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ id: string }>("SELECT id FROM ChecklistTemplate WHERE id = @id");
      if (template.recordset.length === 0) {
        return reply.status(404).send({ erro: "Template de checklist não encontrado." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("template_id", sql.UniqueIdentifier, id)
          .input("descricao", sql.NVarChar, descricao)
          .input("ordem", sql.Int, ordem ?? null)
          .input("obrigatorio", sql.Bit, obrigatorio)
          .input("bloqueia_aprovacao", sql.Bit, bloqueiaAprovacao)
          .query<ItemTemplateRow>(
            `INSERT INTO ChecklistItemTemplate (template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao)
             OUTPUT INSERTED.id, INSERTED.template_id, INSERTED.descricao, INSERTED.ordem,
                    INSERTED.obrigatorio, INSERTED.bloqueia_aprovacao, INSERTED.ativo
             VALUES (
               @template_id, @descricao,
               COALESCE(@ordem, (SELECT ISNULL(MAX(ordem), 0) + 1 FROM ChecklistItemTemplate WHERE template_id = @template_id)),
               @obrigatorio, @bloqueia_aprovacao
             )`
          );
        const novo = insercao.recordset[0];

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, novo.id)
          .input("detalhes", sql.NVarChar, JSON.stringify({ templateId: id, descricao }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'criar_checklist_item_template', 'ChecklistItemTemplate', @entidade_id, @detalhes)`
          );

        await transaction.commit();
        return reply.status(201).send(mapItemTemplate(novo));
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/checklist-itens/:itemId",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string };
      const parsed = editarChecklistItemTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { descricao, obrigatorio, bloqueiaAprovacao } = parsed.data;
      const pool = await getPool();

      // Editar o enunciado NÃO reescreve execuções passadas: cada resposta já gravou seu
      // próprio snapshot do texto e das regras (ver ChecklistResposta.item_descricao). A
      // alteração vale a partir das próximas execuções.
      const atualizacao = await pool
        .request()
        .input("id", sql.UniqueIdentifier, itemId)
        .input("descricao", sql.NVarChar, descricao)
        .input("obrigatorio", sql.Bit, obrigatorio)
        .input("bloqueia_aprovacao", sql.Bit, bloqueiaAprovacao)
        .query<ItemTemplateRow>(
          `UPDATE ChecklistItemTemplate
           SET descricao = @descricao, obrigatorio = @obrigatorio, bloqueia_aprovacao = @bloqueia_aprovacao
           OUTPUT INSERTED.id, INSERTED.template_id, INSERTED.descricao, INSERTED.ordem,
                  INSERTED.obrigatorio, INSERTED.bloqueia_aprovacao, INSERTED.ativo
           WHERE id = @id AND ativo = 1`
        );
      if (atualizacao.recordset.length === 0) {
        return reply.status(404).send({ erro: "Questão não encontrada." });
      }
      return reply.status(200).send(mapItemTemplate(atualizacao.recordset[0]));
    }
  );

  // Remoção é SEMPRE soft delete (ativo = 0). Apagar a linha quebraria a FK das respostas
  // já gravadas e, com ela, o registro de checklists realizados — a questão precisa sumir
  // dos próximos checklists sem desaparecer dos antigos.
  app.delete(
    "/api/v1/checklist-itens/:itemId",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string };
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atualizacao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, itemId)
          .query<{ id: string; template_id: string }>(
            `UPDATE ChecklistItemTemplate SET ativo = 0
             OUTPUT INSERTED.id, INSERTED.template_id
             WHERE id = @id AND ativo = 1`
          );
        if (atualizacao.recordset.length === 0) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Questão não encontrada." });
        }
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, itemId)
          .input("detalhes", sql.NVarChar, JSON.stringify({ templateId: atualizacao.recordset[0].template_id }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'remover_checklist_item_template', 'ChecklistItemTemplate', @entidade_id, @detalhes)`
          );
        await transaction.commit();
        return reply.status(204).send();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    }
  );

  // Reordenação em lote — a ordem definida aqui é a mesma exibida no preenchimento
  // (ChecklistItemTemplate.ordem, usada no ORDER BY de buscarItensERespostas).
  app.put(
    "/api/v1/checklist-modelos/:id/itens/ordem",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = reordenarChecklistItensSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        // Numeração reescrita do zero a cada reordenação, dentro de uma transação: o
        // template nunca fica visível com duas questões na mesma posição.
        for (const [indice, itemId] of parsed.data.itemIds.entries()) {
          await transaction
            .request()
            .input("id", sql.UniqueIdentifier, itemId)
            .input("template_id", sql.UniqueIdentifier, id)
            .input("ordem", sql.Int, indice + 1)
            .query(
              "UPDATE ChecklistItemTemplate SET ordem = @ordem WHERE id = @id AND template_id = @template_id"
            );
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      const itens = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ItemTemplateRow>(
          `SELECT id, template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao, ativo
           FROM ChecklistItemTemplate WHERE template_id = @id AND ativo = 1 ORDER BY ordem`
        );
      return reply.status(200).send(itens.recordset.map(mapItemTemplate));
    }
  );

  // ===========================================================================
  // Central de checklists e preenchimento
  // ===========================================================================

  // RF-CHK-07: uma linha por reserva cuja plataforma exige checklist, com a situação já
  // derivada aqui (nunca recalculada no frontend). Mesmo escopo por setor da listagem
  // principal de reservas: Admin vê tudo, demais perfis só o próprio setor.
  //
  // O recorte por período (`de`/`ate`) é feito no banco, como em GET /reservas: a tela abre
  // no dia atual e não faz sentido trazer o histórico inteiro para filtrar no cliente.
  app.get("/api/v1/checklists", { preHandler: autenticar }, async (request, reply) => {
    const usuario = request.usuario!;
    const { de, ate } = request.query as { de?: string; ate?: string };
    const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
    if ((de && !DATA_REGEX.test(de)) || (ate && !DATA_REGEX.test(ate))) {
      return reply.status(422).send({ erro: "Parâmetros de data inválidos (esperado AAAA-MM-DD)." });
    }

    const pool = await getPool();
    const dbRequest = pool.request();

    let where =
      "WHERE resolved.template_id IS NOT NULL AND r.status NOT IN ('cancelada', 'rejeitada')";
    if (usuario.perfil !== "admin") {
      dbRequest.input("setor_id", sql.UniqueIdentifier, usuario.setorId);
      where += " AND r.setor_id = @setor_id";
    }
    if (de) {
      dbRequest.input("de", sql.Date, de);
      where += " AND r.data >= @de";
    }
    if (ate) {
      dbRequest.input("ate", sql.Date, ate);
      where += " AND r.data <= @ate";
    }

    const result = await dbRequest.query<{
      reserva_id: string;
      reserva_status: string;
      plataforma_id: string;
      plataforma_nome: string;
      plataforma_categoria: CategoriaPlataforma;
      setor_nome: string;
      responsavel_nome: string;
      responsavel_id: string;
      data: string;
      hora_inicio: string;
      hora_fim: string;
      template_nome: string;
      finalizado_em: Date | null;
      todos_conformes: boolean | null;
      total_itens: number;
      total_respondidos: number;
    }>(
      `SELECT r.id AS reserva_id, r.status AS reserva_status,
              p.id AS plataforma_id, p.nome AS plataforma_nome, p.categoria AS plataforma_categoria,
              s.nome AS setor_nome, u.nome AS responsavel_nome, u.id AS responsavel_id,
              CONVERT(varchar(10), r.data, 23) AS data,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
              resolved.template_nome,
              cp.finalizado_em, cp.todos_conformes,
              (SELECT COUNT(*) FROM ChecklistItemTemplate it WHERE it.template_id = resolved.template_id AND it.ativo = 1) AS total_itens,
              (SELECT COUNT(*) FROM ChecklistResposta cr WHERE cr.checklist_preenchido_id = cp.id) AS total_respondidos
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       JOIN Setor s ON s.id = r.setor_id
       JOIN Usuario u ON u.id = r.solicitante_id
       OUTER APPLY (
         SELECT TOP 1 tpl.id AS template_id, tpl.nome AS template_nome
         FROM ChecklistTemplate tpl
         WHERE tpl.id = p.checklist_template_id AND tpl.ativo = 1 AND p.exige_checklist = 1
       ) resolved
       LEFT JOIN ChecklistPreenchido cp ON cp.reserva_id = r.id
       ${where}
       ORDER BY
         CASE WHEN cp.finalizado_em IS NOT NULL THEN 1 ELSE 0 END,
         r.data ASC, r.hora_inicio ASC`
    );

    const linhas = await Promise.all(
      result.recordset.map(async (row) => {
        const situacao = await situacaoChecklistDe({
          requerChecklist: true,
          finalizadoEm: row.finalizado_em,
          totalItens: row.total_itens,
          totalRespondidos: row.total_respondidos,
          todosConformes: row.todos_conformes,
        });
        return {
          reservaId: row.reserva_id,
          reservaStatus: row.reserva_status,
          plataformaId: row.plataforma_id,
          plataformaNome: row.plataforma_nome,
          plataformaCategoria: row.plataforma_categoria,
          setorNome: row.setor_nome,
          responsavelNome: row.responsavel_nome,
          responsavelId: row.responsavel_id,
          data: row.data,
          horaInicio: row.hora_inicio,
          horaFim: row.hora_fim,
          templateNome: row.template_nome,
          situacao: situacao as SituacaoChecklist,
          totalItens: row.total_itens,
          totalRespondidos: row.total_respondidos,
        };
      })
    );

    return reply.status(200).send(linhas);
  });

  // RF-CHK-02/RN-RES-12: consulta o checklist da reserva.
  //
  // Já FINALIZADO: a resposta é montada a partir do snapshot gravado em cada resposta —
  // o registro do que foi assinado naquele momento. Editar, remover ou acrescentar questões
  // no template depois disso não altera esta tela.
  // Ainda em RASCUNHO: reflete o template atual, que é o que ainda será preenchido.
  app.get("/api/v1/reservas/:id/checklist", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContextoReservaChecklist(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode consultar o checklist de reservas do seu próprio setor." });
    }

    const { templateId, templateNome } = await resolverTemplateEfetivo(contexto.plataforma_id);
    if (!templateId) {
      return reply.status(200).send({
        requerChecklist: false,
        templateNome: null,
        apartirDeSnapshot: false,
        finalizadoEm: null,
        todosConformes: null,
        preenchidoPorNome: null,
        preenchidoEm: null,
        totalItens: 0,
        totalRespondidos: 0,
        itens: [],
      });
    }

    const dados = await buscarItensERespostas(templateId, id);
    const finalizado = Boolean(dados.finalizadoEm);

    // S11 (RNF-09): foto_url guarda a CHAVE do arquivo no armazenamento local, não uma URL —
    // a URL de leitura assinada (curta duração) é gerada a cada consulta, nunca persistida
    // (evitaria um link "eterno" se vazado).
    const itens = finalizado
      ? await Promise.all(
          [...dados.respostasPorItem.entries()]
            .sort(([, a], [, b]) => (a.item_ordem ?? 0) - (b.item_ordem ?? 0))
            .map(async ([itemId, resposta]) => ({
              itemId,
              descricao: resposta.item_descricao ?? "(questão removida do template)",
              ordem: resposta.item_ordem ?? 0,
              obrigatorio: resposta.item_obrigatorio ?? true,
              bloqueiaAprovacao: resposta.item_bloqueia_aprovacao ?? true,
              resultado: resposta.resultado,
              observacao: resposta.observacao,
              fotoUrl: urlDeLeitura(resposta.foto_url),
            }))
        )
      : await Promise.all(
          dados.itens.map(async (item) => {
            const resposta = dados.respostasPorItem.get(item.id);
            return {
              itemId: item.id,
              descricao: item.descricao,
              ordem: item.ordem,
              obrigatorio: item.obrigatorio,
              bloqueiaAprovacao: item.bloqueia_aprovacao,
              resultado: resposta?.resultado ?? null,
              observacao: resposta?.observacao ?? null,
              fotoUrl: urlDeLeitura(resposta?.foto_url),
            };
          })
        );

    return reply.status(200).send({
      requerChecklist: true,
      templateNome,
      apartirDeSnapshot: finalizado,
      finalizadoEm: dados.finalizadoEm,
      // Gravado na finalização e nunca recalculado a partir do template atual — é o
      // veredito daquela execução, e é ele que o gate de aprovação consulta.
      todosConformes: finalizado ? await lerTodosConformes(id) : null,
      preenchidoPorNome: dados.preenchidoPorNome,
      preenchidoEm: dados.preenchidoEm,
      totalItens: itens.length,
      totalRespondidos: itens.filter((item) => item.resultado !== null).length,
      itens,
    });
  });

  async function lerTodosConformes(reservaId: string): Promise<boolean | null> {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, reservaId)
      .query<{ todos_conformes: boolean }>(
        "SELECT todos_conformes FROM ChecklistPreenchido WHERE reserva_id = @reserva_id"
      );
    return result.recordset[0]?.todos_conformes ?? null;
  }

  async function salvarRespostas(params: {
    reservaId: string;
    templateId: string;
    usuarioId: string;
    respostas: { itemId: string; resultado: ResultadoItemChecklist; observacao?: string; fotoBase64?: string }[];
    itensTemplate: Map<string, ItemTemplateRow>;
    finalizar: boolean;
  }): Promise<{ preenchidoId: string; todosConformes: boolean }> {
    const pool = await getPool();

    for (const resposta of params.respostas) {
      if (!params.itensTemplate.has(resposta.itemId)) {
        throw new ItemInvalidoError(resposta.itemId);
      }
    }
    validarObservacoesObrigatorias(
      params.respostas.map((r) => ({ itemId: r.itemId, resultado: r.resultado, observacao: r.observacao }))
    );

    const itensTemplate: ItemTemplateChecklist[] = [...params.itensTemplate.values()].map((item) => ({
      itemId: item.id,
      obrigatorio: item.obrigatorio,
      bloqueiaAprovacao: item.bloqueia_aprovacao,
    }));

    if (params.finalizar) {
      validarRespostasParaFinalizar(
        itensTemplate,
        params.respostas.map((r) => ({ itemId: r.itemId, resultado: r.resultado, observacao: r.observacao }))
      );
    }

    const todosConformes = calcularTodosConformes(
      itensTemplate,
      params.respostas.map((r) => ({ itemId: r.itemId, resultado: r.resultado }))
    );

    const respostasComFoto = await Promise.all(
      params.respostas.map(async (resposta) => {
        const item = params.itensTemplate.get(resposta.itemId)!;
        const fotoUrl = resposta.fotoBase64
          ? (await armazenamentoService.salvarFotoBase64(`checklist/${params.reservaId}`, resposta.fotoBase64)).url
          : null;
        // Snapshot capturado no instante da resposta: é isto que a execução vai exibir para
        // sempre, independentemente do que acontecer com o template daqui em diante.
        return {
          ...resposta,
          fotoUrl,
          itemDescricao: item.descricao,
          itemOrdem: item.ordem,
          itemObrigatorio: item.obrigatorio,
          itemBloqueiaAprovacao: item.bloqueia_aprovacao,
        };
      })
    );

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const existente = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, params.reservaId)
        .query<{ id: string }>("SELECT id FROM ChecklistPreenchido WHERE reserva_id = @reserva_id");

      let preenchidoId: string;
      if (existente.recordset.length > 0) {
        preenchidoId = existente.recordset[0].id;
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, preenchidoId)
          .input("preenchido_por_id", sql.UniqueIdentifier, params.usuarioId)
          .input("todos_conformes", sql.Bit, todosConformes)
          .input("finalizado_em", sql.DateTime2, params.finalizar ? new Date() : null)
          .query(
            `UPDATE ChecklistPreenchido
             SET preenchido_por_id = @preenchido_por_id, todos_conformes = @todos_conformes,
                 preenchido_em = SYSUTCDATETIME(), finalizado_em = @finalizado_em
             WHERE id = @id`
          );
      } else {
        const insercao = await transaction
          .request()
          .input("reserva_id", sql.UniqueIdentifier, params.reservaId)
          .input("preenchido_por_id", sql.UniqueIdentifier, params.usuarioId)
          .input("todos_conformes", sql.Bit, todosConformes)
          .input("finalizado_em", sql.DateTime2, params.finalizar ? new Date() : null)
          .query<{ id: string }>(
            `INSERT INTO ChecklistPreenchido (reserva_id, preenchido_por_id, todos_conformes, finalizado_em)
             OUTPUT INSERTED.id
             VALUES (@reserva_id, @preenchido_por_id, @todos_conformes, @finalizado_em)`
          );
        preenchidoId = insercao.recordset[0].id;
      }

      // Upsert item a item (MERGE): preserva respostas de itens não incluídos neste envio —
      // o preenchimento de rascunho manda só o que mudou, não a lista inteira toda vez.
      for (const resposta of respostasComFoto) {
        await transaction
          .request()
          .input("checklist_preenchido_id", sql.UniqueIdentifier, preenchidoId)
          .input("item_id", sql.UniqueIdentifier, resposta.itemId)
          .input("resultado", sql.VarChar, resposta.resultado)
          .input("observacao", sql.NVarChar, resposta.observacao ?? null)
          .input("foto_url", sql.NVarChar, resposta.fotoUrl)
          .input("item_descricao", sql.NVarChar, resposta.itemDescricao)
          .input("item_ordem", sql.Int, resposta.itemOrdem)
          .input("item_obrigatorio", sql.Bit, resposta.itemObrigatorio)
          .input("item_bloqueia_aprovacao", sql.Bit, resposta.itemBloqueiaAprovacao)
          .query(
            `MERGE ChecklistResposta AS alvo
             USING (SELECT @checklist_preenchido_id AS checklist_preenchido_id, @item_id AS item_id) AS origem
             ON alvo.checklist_preenchido_id = origem.checklist_preenchido_id AND alvo.item_id = origem.item_id
             WHEN MATCHED THEN UPDATE SET
               resultado = @resultado, observacao = @observacao, foto_url = @foto_url,
               item_descricao = @item_descricao, item_ordem = @item_ordem,
               item_obrigatorio = @item_obrigatorio, item_bloqueia_aprovacao = @item_bloqueia_aprovacao
             WHEN NOT MATCHED THEN INSERT (
               checklist_preenchido_id, item_id, resultado, observacao, foto_url,
               item_descricao, item_ordem, item_obrigatorio, item_bloqueia_aprovacao)
               VALUES (@checklist_preenchido_id, @item_id, @resultado, @observacao, @foto_url,
                       @item_descricao, @item_ordem, @item_obrigatorio, @item_bloqueia_aprovacao);`
          );
      }

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, params.usuarioId)
        .input("entidade_id", sql.UniqueIdentifier, params.reservaId)
        .input(
          "detalhes",
          sql.NVarChar,
          JSON.stringify({ finalizar: params.finalizar, todosConformes, totalRespostas: respostasComFoto.length })
        )
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, '${params.finalizar ? "finalizar_checklist" : "salvar_rascunho_checklist"}', 'Reserva', @entidade_id, @detalhes)`
        );

      await transaction.commit();
      return { preenchidoId, todosConformes };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  class ItemInvalidoError extends Error {
    constructor(public readonly itemId: string) {
      super(`Item de checklist inválido para esta plataforma: ${itemId}.`);
    }
  }

  // Preparação comum ao rascunho e à finalização: resolve a reserva, o escopo do usuário e
  // o template efetivo da plataforma, devolvendo os itens ativos indexados por id.
  async function prepararPreenchimento(
    reservaId: string,
    usuario: { sub: string; perfil: string; setorId: string | null }
  ): Promise<
    | { ok: false; status: number; erro: string }
    | { ok: true; templateId: string; itensTemplate: Map<string, ItemTemplateRow> }
  > {
    const contexto = await buscarContextoReservaChecklist(reservaId);
    if (!contexto) {
      return { ok: false, status: 404, erro: "Reserva não encontrada." };
    }
    if (!usuarioNoEscopoDaReserva(usuario as never, contexto.setor_id)) {
      return {
        ok: false,
        status: 403,
        erro: "Você só pode preencher o checklist de reservas do seu próprio setor.",
      };
    }
    if (estadoFinal(contexto.status)) {
      return {
        ok: false,
        status: 409,
        erro: `Reserva com status "${contexto.status}" é somente leitura (RN-RES-04).`,
      };
    }

    const { templateId } = await resolverTemplateEfetivo(contexto.plataforma_id);
    if (!templateId) {
      return { ok: false, status: 409, erro: "Esta plataforma não exige checklist de segurança." };
    }

    const pool = await getPool();
    const itensResult = await pool
      .request()
      .input("template_id", sql.UniqueIdentifier, templateId)
      .query<ItemTemplateRow>(
        `SELECT id, template_id, descricao, ordem, obrigatorio, bloqueia_aprovacao, ativo
         FROM ChecklistItemTemplate WHERE template_id = @template_id AND ativo = 1`
      );
    return {
      ok: true,
      templateId,
      itensTemplate: new Map(itensResult.recordset.map((item) => [item.id, item])),
    };
  }

  // RF-CHK-06: salva progresso (rascunho) — aceita um subconjunto dos itens do template.
  // Não finaliza (finalizado_em zera se o checklist já tinha sido finalizado antes — editar
  // respostas depois de finalizar exige finalizar de novo para valer na aprovação, RN-CHK-03).
  app.put("/api/v1/reservas/:id/checklist", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = preencherChecklistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const preparo = await prepararPreenchimento(id, request.usuario!);
    if (!preparo.ok) {
      return reply.status(preparo.status).send({ erro: preparo.erro });
    }

    try {
      const resultado = await salvarRespostas({
        reservaId: id,
        templateId: preparo.templateId,
        usuarioId: request.usuario!.sub,
        respostas: parsed.data.respostas,
        itensTemplate: preparo.itensTemplate,
        finalizar: false,
      });
      return reply.status(200).send({ finalizado: false, todosConformes: resultado.todosConformes });
    } catch (err) {
      if (err instanceof ItemInvalidoError || err instanceof ObservacaoObrigatoriaError) {
        return reply.status(422).send({ erro: err.message });
      }
      throw err;
    }
  });

  // RF-CHK-06/RN-CHK-03: finaliza o checklist — exige todos os itens obrigatórios
  // respondidos. Só a partir daqui o checklist conta para liberar a aprovação da reserva
  // (POST /reservas/:id/aprovar).
  app.post("/api/v1/reservas/:id/checklist/finalizar", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = preencherChecklistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const preparo = await prepararPreenchimento(id, request.usuario!);
    if (!preparo.ok) {
      return reply.status(preparo.status).send({ erro: preparo.erro });
    }

    let resultado: { preenchidoId: string; todosConformes: boolean };
    try {
      resultado = await salvarRespostas({
        reservaId: id,
        templateId: preparo.templateId,
        usuarioId: request.usuario!.sub,
        respostas: parsed.data.respostas,
        itensTemplate: preparo.itensTemplate,
        finalizar: true,
      });
    } catch (err) {
      if (
        err instanceof ItemInvalidoError ||
        err instanceof ObservacaoObrigatoriaError ||
        err instanceof ItemObrigatorioNaoRespondidoError
      ) {
        return reply.status(422).send({ erro: err.message });
      }
      throw err;
    }

    // RF-CHK-03/RN-CHK-02: item não conforme impeditivo não muda status automaticamente —
    // apenas notifica o Admin para revisão manual da plataforma.
    if (!resultado.todosConformes) {
      const pool = await getPool();
      const [admins, reservaInfo] = await Promise.all([
        pool.request().query<{ email: string }>("SELECT email FROM Usuario WHERE perfil = 'admin' AND ativo = 1"),
        pool
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ plataforma_nome: string; setor_nome: string }>(
            `SELECT p.nome AS plataforma_nome, s.nome AS setor_nome
             FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id JOIN Setor s ON s.id = r.setor_id
             WHERE r.id = @id`
          ),
      ]);
      const { plataforma_nome, setor_nome } = reservaInfo.recordset[0];
      const { assunto, corpoHtml } = templateChecklistNaoConforme({
        plataformaNome: plataforma_nome,
        setorNome: setor_nome,
      });
      await Promise.all(
        admins.recordset.map((admin) => enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml }))
      );
    }

    return reply.status(200).send({ finalizado: true, todosConformes: resultado.todosConformes });
  });
}
