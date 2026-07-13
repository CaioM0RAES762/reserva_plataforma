import type { FastifyInstance } from "fastify";
import {
  criarChecklistItemTemplateSchema,
  preencherChecklistSchema,
  type CategoriaPlataforma,
  type StatusReserva,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import {
  calcularTodosConformes,
  ObservacaoObrigatoriaError,
  ItemObrigatorioNaoRespondidoError,
  requerChecklist,
  validarRespostasChecklist,
} from "../services/checklist.service.js";
import { estadoFinal } from "../services/aprovacao.service.js";
import { armazenamentoService } from "../services/storage.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateChecklistNaoConforme } from "../services/email.service.js";

interface ItemTemplateRow {
  id: string;
  categoria_plataforma: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  ativo: boolean;
}

function mapItemTemplate(row: ItemTemplateRow) {
  return {
    id: row.id,
    categoriaPlataforma: row.categoria_plataforma,
    descricao: row.descricao,
    ordem: row.ordem,
    obrigatorio: row.obrigatorio,
    ativo: row.ativo,
  };
}

interface ReservaChecklistContexto {
  id: string;
  status: StatusReserva;
  setor_id: string;
  plataforma_categoria: CategoriaPlataforma;
}

async function buscarContextoReservaChecklist(id: string): Promise<ReservaChecklistContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaChecklistContexto>(
      `SELECT r.id, r.status, r.setor_id, p.categoria AS plataforma_categoria
       FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

export async function checklistRoutes(app: FastifyInstance): Promise<void> {
  // RF-CHK-01: templates por categoria de plataforma — leitura liberada a todos os
  // perfis autenticados (a tela de preenchimento do checklist precisa deles).
  app.get("/api/v1/checklist-templates", { preHandler: autenticar }, async (request, reply) => {
    const { categoria } = request.query as { categoria?: string };
    const pool = await getPool();
    const dbRequest = pool.request();

    let where = "WHERE ativo = 1";
    if (categoria) {
      dbRequest.input("categoria", sql.VarChar, categoria);
      where += " AND categoria_plataforma = @categoria";
    }

    const result = await dbRequest.query<ItemTemplateRow>(
      `SELECT id, categoria_plataforma, descricao, ordem, obrigatorio, ativo
       FROM ChecklistItemTemplate ${where} ORDER BY categoria_plataforma, ordem`
    );
    return reply.status(200).send(result.recordset.map(mapItemTemplate));
  });

  app.post(
    "/api/v1/checklist-templates",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarChecklistItemTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { categoriaPlataforma, descricao, ordem, obrigatorio } = parsed.data;
      const pool = await getPool();

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("categoria", sql.VarChar, categoriaPlataforma)
          .input("descricao", sql.NVarChar, descricao)
          .input("ordem", sql.Int, ordem)
          .input("obrigatorio", sql.Bit, obrigatorio)
          .query<ItemTemplateRow>(
            `INSERT INTO ChecklistItemTemplate (categoria_plataforma, descricao, ordem, obrigatorio)
             OUTPUT INSERTED.id, INSERTED.categoria_plataforma, INSERTED.descricao, INSERTED.ordem,
                    INSERTED.obrigatorio, INSERTED.ativo
             VALUES (@categoria, @descricao, @ordem, @obrigatorio)`
          );
        const novo = insercao.recordset[0];

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, novo.id)
          .input("detalhes", sql.NVarChar, JSON.stringify({ categoriaPlataforma, descricao }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'criar_checklist_item_template', 'ChecklistItemTemplate', @entidade_id, @detalhes)`
          );

        await transaction.commit();
        return reply.status(201).send(mapItemTemplate(novo));
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );

  // RF-CHK-02/RN-RES-12: consulta o checklist da reserva — template da categoria da
  // plataforma + respostas já preenchidas (se houver). Espelha o mesmo escopo de
  // setor usado nas demais rotas de reserva (usuarioNoEscopoDaReserva, S7).
  app.get("/api/v1/reservas/:id/checklist", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContextoReservaChecklist(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode consultar o checklist de reservas do seu próprio setor." });
    }

    const exige = requerChecklist(contexto.plataforma_categoria);
    if (!exige) {
      return reply.status(200).send({
        requerChecklist: false,
        todosConformes: null,
        preenchidoPorNome: null,
        preenchidoEm: null,
        itens: [],
      });
    }

    const pool = await getPool();
    const [templateResult, preenchidoResult] = await Promise.all([
      pool
        .request()
        .input("categoria", sql.VarChar, contexto.plataforma_categoria)
        .query<ItemTemplateRow>(
          `SELECT id, categoria_plataforma, descricao, ordem, obrigatorio, ativo
           FROM ChecklistItemTemplate WHERE categoria_plataforma = @categoria AND ativo = 1 ORDER BY ordem`
        ),
      pool
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .query<{
          todos_conformes: boolean;
          preenchido_em: Date;
          preenchido_por_nome: string;
          item_id: string | null;
          conforme: boolean | null;
          observacao: string | null;
          foto_url: string | null;
        }>(
          `SELECT cp.todos_conformes, cp.preenchido_em, u.nome AS preenchido_por_nome,
                  cr.item_id, cr.conforme, cr.observacao, cr.foto_url
           FROM ChecklistPreenchido cp
           JOIN Usuario u ON u.id = cp.preenchido_por_id
           LEFT JOIN ChecklistResposta cr ON cr.checklist_preenchido_id = cp.id
           WHERE cp.reserva_id = @reserva_id`
        ),
    ]);

    const linhasPreenchido = preenchidoResult.recordset;
    const cabecalho = linhasPreenchido[0] ?? null;
    const respostasPorItem = new Map(
      linhasPreenchido
        .filter((l) => l.item_id !== null)
        .map((l) => [l.item_id as string, l])
    );

    const itens = templateResult.recordset.map((item) => {
      const resposta = respostasPorItem.get(item.id);
      return {
        itemId: item.id,
        descricao: item.descricao,
        ordem: item.ordem,
        obrigatorio: item.obrigatorio,
        conforme: resposta?.conforme ?? null,
        observacao: resposta?.observacao ?? null,
        fotoUrl: resposta?.foto_url ?? null,
      };
    });

    return reply.status(200).send({
      requerChecklist: true,
      todosConformes: cabecalho ? cabecalho.todos_conformes : null,
      preenchidoPorNome: cabecalho ? cabecalho.preenchido_por_nome : null,
      preenchidoEm: cabecalho ? cabecalho.preenchido_em : null,
      itens,
    });
  });

  // RF-CHK-02/RN-CHK-01/RN-CHK-02: preenche (ou atualiza) o checklist da reserva.
  app.put("/api/v1/reservas/:id/checklist", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = preencherChecklistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const contexto = await buscarContextoReservaChecklist(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
      return reply
        .status(403)
        .send({ erro: "Você só pode preencher o checklist de reservas do seu próprio setor." });
    }
    if (estadoFinal(contexto.status)) {
      return reply
        .status(409)
        .send({ erro: `Reserva com status "${contexto.status}" é somente leitura (RN-RES-04).` });
    }
    if (!requerChecklist(contexto.plataforma_categoria)) {
      return reply.status(409).send({ erro: "Esta plataforma não exige checklist de segurança." });
    }

    const pool = await getPool();
    const templateResult = await pool
      .request()
      .input("categoria", sql.VarChar, contexto.plataforma_categoria)
      .query<ItemTemplateRow>(
        `SELECT id, obrigatorio FROM ChecklistItemTemplate WHERE categoria_plataforma = @categoria AND ativo = 1`
      );
    const itensTemplate = templateResult.recordset.map((r) => ({ itemId: r.id, obrigatorio: r.obrigatorio }));
    const idsValidos = new Set(itensTemplate.map((i) => i.itemId));

    for (const resposta of parsed.data.respostas) {
      if (!idsValidos.has(resposta.itemId)) {
        return reply.status(422).send({ erro: `Item de checklist inválido para esta plataforma: ${resposta.itemId}.` });
      }
    }

    try {
      validarRespostasChecklist(itensTemplate, parsed.data.respostas);
    } catch (err) {
      if (err instanceof ItemObrigatorioNaoRespondidoError || err instanceof ObservacaoObrigatoriaError) {
        return reply.status(422).send({ erro: err.message });
      }
      throw err;
    }

    const todosConformes = calcularTodosConformes(itensTemplate, parsed.data.respostas);

    // Fotos são salvas fora da transação de banco (I/O de disco) e referenciadas por URL.
    const respostasComFoto = await Promise.all(
      parsed.data.respostas.map(async (resposta) => {
        if (!resposta.fotoBase64) {
          return { ...resposta, fotoUrl: null as string | null };
        }
        const salvo = await armazenamentoService.salvarFotoBase64(`checklist/${id}`, resposta.fotoBase64);
        return { ...resposta, fotoUrl: salvo.url };
      })
    );

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const existente = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .query<{ id: string }>("SELECT id FROM ChecklistPreenchido WHERE reserva_id = @reserva_id");

      let preenchidoId: string;
      if (existente.recordset.length > 0) {
        preenchidoId = existente.recordset[0].id;
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, preenchidoId)
          .input("preenchido_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("todos_conformes", sql.Bit, todosConformes)
          .query(
            `UPDATE ChecklistPreenchido
             SET preenchido_por_id = @preenchido_por_id, todos_conformes = @todos_conformes, preenchido_em = SYSUTCDATETIME()
             WHERE id = @id`
          );
        await transaction
          .request()
          .input("checklist_preenchido_id", sql.UniqueIdentifier, preenchidoId)
          .query("DELETE FROM ChecklistResposta WHERE checklist_preenchido_id = @checklist_preenchido_id");
      } else {
        const insercao = await transaction
          .request()
          .input("reserva_id", sql.UniqueIdentifier, id)
          .input("preenchido_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("todos_conformes", sql.Bit, todosConformes)
          .query<{ id: string }>(
            `INSERT INTO ChecklistPreenchido (reserva_id, preenchido_por_id, todos_conformes)
             OUTPUT INSERTED.id
             VALUES (@reserva_id, @preenchido_por_id, @todos_conformes)`
          );
        preenchidoId = insercao.recordset[0].id;
      }

      for (const resposta of respostasComFoto) {
        await transaction
          .request()
          .input("checklist_preenchido_id", sql.UniqueIdentifier, preenchidoId)
          .input("item_id", sql.UniqueIdentifier, resposta.itemId)
          .input("conforme", sql.Bit, resposta.conforme)
          .input("observacao", sql.NVarChar, resposta.observacao ?? null)
          .input("foto_url", sql.NVarChar, resposta.fotoUrl)
          .query(
            `INSERT INTO ChecklistResposta (checklist_preenchido_id, item_id, conforme, observacao, foto_url)
             VALUES (@checklist_preenchido_id, @item_id, @conforme, @observacao, @foto_url)`
          );
      }

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("entidade_id", sql.UniqueIdentifier, id)
        .input("detalhes", sql.NVarChar, JSON.stringify({ todosConformes, totalRespostas: respostasComFoto.length }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'preencher_checklist', 'Reserva', @entidade_id, @detalhes)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    // RF-CHK-03/RN-CHK-02: item obrigatório não conforme não muda status automaticamente —
    // apenas notifica o Admin para revisão manual da plataforma.
    if (!todosConformes) {
      const [admins, reservaInfo] = await Promise.all([
        pool
          .request()
          .query<{ email: string }>("SELECT email FROM Usuario WHERE perfil = 'admin' AND ativo = 1"),
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

    return reply.status(200).send({ todosConformes });
  });
}
