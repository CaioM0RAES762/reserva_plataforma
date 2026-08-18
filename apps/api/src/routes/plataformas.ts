import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  atualizarStatusPlataformaSchema,
  criarPlataformaSchema,
  editarPlataformaSchema,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import {
  calcularNormasPlataforma,
  normalizarCodigoPlataforma,
  resolverRiscoPlataforma,
  sqlEventoAtivoPlataforma,
  sqlStatusPlataformaDerivado,
  sqlUtilizacao30dPlataforma,
} from "../services/plataforma.service.js";
import { publicarEventoGlobal } from "../services/eventos.service.js";
import {
  armazenamentoService,
  ArquivoExcedeLimiteError,
  gerarUrlAcessoOuNulo,
  MimeNaoPermitidoError,
} from "../services/storage.service.js";

const CONFLITO_UNIQUE_SQL_ERROS = new Set([2601, 2627]);

interface PlataformaRow {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  capacidade: number | null;
  status: string;
  categoria: string;
  risco: string;
  aprovacao_automatica: boolean;
  observacoes: string | null;
  imagem_url: string | null;
  tipo_equipamento: string | null;
  altura_maxima_m: number | null;
  capacidade_operadores: number | null;
  horimetro_horas: number | null;
  utilizacao_30d: number | null;
  evento_texto: string | null;
  evento_detalhe: string | null;
  exige_checklist: boolean;
  checklist_template_id: string | null;
  checklist_template_nome: string | null;
  checklist_total_questoes: number | null;
  inicio_automatico_padrao: boolean;
  fim_automatico_padrao: boolean;
  criado_em: Date;
  atualizado_em: Date;
}

async function mapPlataforma(row: PlataformaRow, aoFalharImagem?: (erro: unknown) => void) {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    localizacao: row.localizacao,
    capacidade: row.capacidade,
    status: row.status,
    categoria: row.categoria,
    risco: row.risco,
    aprovacaoAutomatica: row.aprovacao_automatica,
    observacoes: row.observacoes,
    // Chave do blob nunca sai da API — sempre convertida em SAS de leitura sob demanda.
    // Falha na assinatura degrada para `null` (a UI mostra "Sem imagem") em vez de
    // derrubar a listagem inteira com 500 — ver gerarUrlAcessoOuNulo.
    imagemUrl: await gerarUrlAcessoOuNulo(row.imagem_url, aoFalharImagem),
    tipoEquipamento: row.tipo_equipamento,
    alturaMaximaM: row.altura_maxima_m,
    capacidadeOperadores: row.capacidade_operadores,
    horimetroHoras: row.horimetro_horas,
    utilizacao30d: row.utilizacao_30d,
    evento: row.evento_texto ? { texto: row.evento_texto, detalhe: row.evento_detalhe } : null,
    normas: calcularNormasPlataforma(row.categoria, row.altura_maxima_m),
    // Configuração de segurança do equipamento — o que decide se a reserva desta plataforma
    // passa pela etapa de checklist antes da aprovação. O nome/contagem do template vêm
    // junto para a Frota exibir "NR-18/35 — Plataforma Elevatória · 6 questões" e oferecer o
    // atalho de edição sem uma segunda requisição.
    exigeChecklist: row.exige_checklist,
    checklistTemplateId: row.checklist_template_id,
    checklistTemplateNome: row.checklist_template_nome,
    checklistTotalQuestoes: row.checklist_total_questoes,
    inicioAutomaticoPadrao: row.inicio_automatico_padrao,
    fimAutomaticoPadrao: row.fim_automatico_padrao,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const SELECT_COLUNAS =
  "id, codigo, nome, localizacao, capacidade, status, categoria, risco, aprovacao_automatica, " +
  "observacoes, imagem_url, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas, " +
  "utilizacao_30d, evento_texto, evento_detalhe, exige_checklist, checklist_template_id, " +
  "checklist_template_nome, checklist_total_questoes, inicio_automatico_padrao, fim_automatico_padrao, " +
  "criado_em, atualizado_em";

// CTE reutilizada pela listagem e por buscarPlataformaPorId (recarrega o registro
// completo, com os campos computados, depois de um INSERT/UPDATE) — evita duplicar a
// lógica de status derivado, utilização e evento em destaque em três lugares.
function buildQueryPlataformas(whereEOrder: string): string {
  return `
    WITH PlataformaComStatus AS (
      SELECT p.id, p.codigo, p.nome, p.localizacao, p.capacidade,
             ${sqlStatusPlataformaDerivado("p")} AS status,
             p.categoria, p.risco, p.aprovacao_automatica, p.observacoes, p.imagem_url,
             p.tipo_equipamento, p.altura_maxima_m, p.capacidade_operadores, p.horimetro_horas,
             ${sqlUtilizacao30dPlataforma("p")} AS utilizacao_30d,
             evento_ativo.texto AS evento_texto, evento_ativo.detalhe AS evento_detalhe,
             p.exige_checklist, p.checklist_template_id,
             tpl.nome AS checklist_template_nome,
             CASE WHEN tpl.id IS NULL THEN NULL ELSE (
               SELECT COUNT(*) FROM ChecklistItemTemplate it WHERE it.template_id = tpl.id AND it.ativo = 1
             ) END AS checklist_total_questoes,
             p.inicio_automatico_padrao, p.fim_automatico_padrao,
             p.criado_em, p.atualizado_em
      FROM Plataforma p
      LEFT JOIN ChecklistTemplate tpl ON tpl.id = p.checklist_template_id
      ${sqlEventoAtivoPlataforma("p")}
    )
    SELECT ${SELECT_COLUNAS} FROM PlataformaComStatus ${whereEOrder}
  `;
}

async function buscarPlataformaPorId(
  pool: Awaited<ReturnType<typeof getPool>>,
  id: string
): Promise<PlataformaRow | null> {
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<PlataformaRow>(buildQueryPlataformas("WHERE id = @id"));
  return result.recordset[0] ?? null;
}

async function registrarAuditoria(
  transaction: sql.Transaction,
  usuarioId: string,
  acao: string,
  entidadeId: string,
  detalhes: Record<string, unknown>
): Promise<void> {
  await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("acao", sql.VarChar, acao)
    .input("entidade", sql.VarChar, "Plataforma")
    .input("entidade_id", sql.UniqueIdentifier, entidadeId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
    );
}

export async function plataformasRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/plataformas", { preHandler: autenticar }, async (request, reply) => {
    const { q, status } = request.query as { q?: string; status?: string };
    const pool = await getPool();
    const dbRequest = pool.request();

    // RN-PLAT-03: "reservada" é derivado em tempo de leitura via CTE (nunca persistido) —
    // por isso o filtro de status abaixo é aplicado sobre o status já calculado.
    let where = "WHERE 1=1";
    if (q) {
      dbRequest.input("q", sql.NVarChar, `%${q}%`);
      where += " AND (nome LIKE @q OR codigo LIKE @q OR localizacao LIKE @q)";
    }
    if (status) {
      dbRequest.input("status", sql.VarChar, status);
      where += " AND status = @status";
    }

    const result = await dbRequest.query<PlataformaRow>(buildQueryPlataformas(`${where} ORDER BY codigo`));
    // Uma única advertência por requisição, mesmo com várias imagens indisponíveis —
    // evita inundar o log quando o Blob Storage está fora do ar.
    let imagemJaAvisada = false;
    const aoFalharImagem = (erro: unknown) => {
      if (imagemJaAvisada) return;
      imagemJaAvisada = true;
      request.log.warn({ err: erro }, "falha ao gerar URL de imagem de plataforma — exibindo sem imagem");
    };
    return reply
      .status(200)
      .send(await Promise.all(result.recordset.map((row) => mapPlataforma(row, aoFalharImagem))));
  });

  app.post(
    "/api/v1/plataformas",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const codigo = normalizarCodigoPlataforma(parsed.data.codigo);
      const risco = resolverRiscoPlataforma(parsed.data.categoria, parsed.data.risco);
      const pool = await getPool();

      const existente = await pool
        .request()
        .input("codigo", sql.VarChar, codigo)
        .query("SELECT id FROM Plataforma WHERE codigo = @codigo");
      if (existente.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
      }

      // Upload feito fora da transação de banco (mesmo padrão de anexos.ts) — id
      // gerado aqui para poder nomear a pasta do blob antes do INSERT existir.
      const novoId = randomUUID();
      let imagemUrlBlob: string | null = null;
      if (parsed.data.imagemBase64) {
        try {
          const salvo = await armazenamentoService.salvarFotoBase64(`plataformas/${novoId}`, parsed.data.imagemBase64);
          imagemUrlBlob = salvo.url;
        } catch (err) {
          if (err instanceof MimeNaoPermitidoError || err instanceof ArquivoExcedeLimiteError) {
            return reply.status(422).send({ erro: err.message });
          }
          throw err;
        }
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, novoId)
          .input("codigo", sql.VarChar, codigo)
          .input("nome", sql.NVarChar, parsed.data.nome)
          .input("localizacao", sql.NVarChar, parsed.data.localizacao ?? null)
          .input("capacidade", sql.Int, parsed.data.capacidade ?? null)
          .input("categoria", sql.VarChar, parsed.data.categoria)
          .input("risco", sql.VarChar, risco)
          .input("aprovacao_automatica", sql.Bit, parsed.data.aprovacaoAutomatica)
          .input("observacoes", sql.NVarChar, parsed.data.observacoes ?? null)
          .input("imagem_url", sql.NVarChar, imagemUrlBlob)
          .input("tipo_equipamento", sql.NVarChar, parsed.data.tipoEquipamento ?? null)
          .input("altura_maxima_m", sql.Decimal(4, 1), parsed.data.alturaMaximaM ?? null)
          .input("capacidade_operadores", sql.Int, parsed.data.capacidadeOperadores ?? null)
          .input("horimetro_horas", sql.Int, parsed.data.horimetroHoras ?? null)
          .input("exige_checklist", sql.Bit, parsed.data.exigeChecklist)
          // Só persiste o vínculo quando a plataforma de fato exige checklist — assim
          // desmarcar "exige" não deixa um template órfão apontado, que voltaria a valer
          // silenciosamente se a opção fosse remarcada depois.
          .input(
            "checklist_template_id",
            sql.UniqueIdentifier,
            parsed.data.exigeChecklist ? parsed.data.checklistTemplateId ?? null : null
          )
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .query(
            `INSERT INTO Plataforma (
               id, codigo, nome, localizacao, capacidade, categoria, risco, aprovacao_automatica,
               observacoes, imagem_url, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas,
               exige_checklist, checklist_template_id, inicio_automatico_padrao, fim_automatico_padrao
             )
             VALUES (
               @id, @codigo, @nome, @localizacao, @capacidade, @categoria, @risco, @aprovacao_automatica,
               @observacoes, @imagem_url, @tipo_equipamento, @altura_maxima_m, @capacidade_operadores, @horimetro_horas,
               @exige_checklist, @checklist_template_id, @inicio_automatico_padrao, @fim_automatico_padrao
             )`
          );

        await registrarAuditoria(transaction, request.usuario!.sub, "criar_plataforma", novoId, {
          codigo,
          nome: parsed.data.nome,
        });

        await transaction.commit();
        const completa = await buscarPlataformaPorId(pool, novoId);
        return reply.status(201).send(await mapPlataforma(completa!));
      } catch (err) {
        await transaction.rollback();
        if (imagemUrlBlob) {
          await armazenamentoService.excluirArquivo(imagemUrlBlob).catch(() => undefined);
        }
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
        }
        throw err;
      }
    }
  );

  app.put(
    "/api/v1/plataformas/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = editarPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const codigo = normalizarCodigoPlataforma(parsed.data.codigo);
      const risco = resolverRiscoPlataforma(parsed.data.categoria, parsed.data.risco);
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ id: string; imagem_url: string | null }>("SELECT id, imagem_url FROM Plataforma WHERE id = @id");
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }
      const imagemAnteriorBlob = atual.recordset[0].imagem_url;

      const duplicado = await pool
        .request()
        .input("codigo", sql.VarChar, codigo)
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM Plataforma WHERE codigo = @codigo AND id <> @id");
      if (duplicado.recordset.length > 0) {
        return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
      }

      // Upload feito fora da transação de banco (mesmo padrão de anexos.ts/criação acima).
      // - imagemBase64 enviada: substitui a imagem atual (blob antigo é removido após o commit).
      // - removerImagem = true (sem imagemBase64): apaga a imagem atual.
      // - nenhum dos dois: mantém a imagem atual como está.
      let novaImagemUrlBlob: string | null | undefined;
      if (parsed.data.imagemBase64) {
        try {
          const salvo = await armazenamentoService.salvarFotoBase64(`plataformas/${id}`, parsed.data.imagemBase64);
          novaImagemUrlBlob = salvo.url;
        } catch (err) {
          if (err instanceof MimeNaoPermitidoError || err instanceof ArquivoExcedeLimiteError) {
            return reply.status(422).send({ erro: err.message });
          }
          throw err;
        }
      } else if (parsed.data.removerImagem) {
        novaImagemUrlBlob = null;
      }
      const imagemUrlFinal = novaImagemUrlBlob !== undefined ? novaImagemUrlBlob : imagemAnteriorBlob;

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("codigo", sql.VarChar, codigo)
          .input("nome", sql.NVarChar, parsed.data.nome)
          .input("localizacao", sql.NVarChar, parsed.data.localizacao ?? null)
          .input("capacidade", sql.Int, parsed.data.capacidade ?? null)
          .input("categoria", sql.VarChar, parsed.data.categoria)
          .input("risco", sql.VarChar, risco)
          .input("aprovacao_automatica", sql.Bit, parsed.data.aprovacaoAutomatica)
          .input("observacoes", sql.NVarChar, parsed.data.observacoes ?? null)
          .input("imagem_url", sql.NVarChar, imagemUrlFinal)
          .input("tipo_equipamento", sql.NVarChar, parsed.data.tipoEquipamento ?? null)
          .input("altura_maxima_m", sql.Decimal(4, 1), parsed.data.alturaMaximaM ?? null)
          .input("capacidade_operadores", sql.Int, parsed.data.capacidadeOperadores ?? null)
          .input("horimetro_horas", sql.Int, parsed.data.horimetroHoras ?? null)
          .input("exige_checklist", sql.Bit, parsed.data.exigeChecklist)
          .input(
            "checklist_template_id",
            sql.UniqueIdentifier,
            parsed.data.exigeChecklist ? parsed.data.checklistTemplateId ?? null : null
          )
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .query(
            `UPDATE Plataforma SET
               codigo = @codigo, nome = @nome, localizacao = @localizacao,
               capacidade = @capacidade, categoria = @categoria, risco = @risco,
               aprovacao_automatica = @aprovacao_automatica, observacoes = @observacoes,
               imagem_url = @imagem_url, tipo_equipamento = @tipo_equipamento,
               altura_maxima_m = @altura_maxima_m, capacidade_operadores = @capacidade_operadores,
               horimetro_horas = @horimetro_horas,
               exige_checklist = @exige_checklist, checklist_template_id = @checklist_template_id,
               inicio_automatico_padrao = @inicio_automatico_padrao,
               fim_automatico_padrao = @fim_automatico_padrao,
               atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );

        // A configuração de checklist entra na auditoria: "por que esta reserva não pediu
        // checklist?" precisa ser respondível pelo histórico, não só pelo estado atual.
        await registrarAuditoria(transaction, request.usuario!.sub, "editar_plataforma", id, {
          codigo,
          nome: parsed.data.nome,
          exigeChecklist: parsed.data.exigeChecklist,
          checklistTemplateId: parsed.data.exigeChecklist ? parsed.data.checklistTemplateId ?? null : null,
        });

        await transaction.commit();
        // Remove o blob antigo só depois do commit confirmar a troca/remoção (best-effort).
        if (imagemAnteriorBlob && imagemAnteriorBlob !== imagemUrlFinal) {
          await armazenamentoService.excluirArquivo(imagemAnteriorBlob).catch(() => undefined);
        }
        const completa = await buscarPlataformaPorId(pool, id);
        return reply.status(200).send(await mapPlataforma(completa!));
      } catch (err) {
        await transaction.rollback();
        if (novaImagemUrlBlob) {
          await armazenamentoService.excluirArquivo(novaImagemUrlBlob).catch(() => undefined);
        }
        const sqlErr = err as { number?: number };
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: "Já existe uma plataforma com este código." });
        }
        throw err;
      }
    }
  );

  app.patch(
    "/api/v1/plataformas/:id/status",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarStatusPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const { status } = parsed.data;
      const pool = await getPool();

      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id, status FROM Plataforma WHERE id = @id");
      const plataforma = atual.recordset[0];
      if (!plataforma) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }

      if (status === "inativa") {
        // RN-PLAT-02: só pode desativar se não houver reservas pendente/agendada/em_uso.
        // Validação estrutural desde já — Reserva ainda não tem rotas de escrita até S3,
        // mas a checagem aqui evita reintroduzir a regra numa migration futura.
        const reservasAtivas = await pool
          .request()
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .query(
            `SELECT TOP 1 id FROM Reserva
             WHERE plataforma_id = @plataforma_id AND status IN ('pendente','agendada','em_uso')`
          );
        if (reservasAtivas.recordset.length > 0) {
          return reply
            .status(409)
            .send({ erro: "Existem reservas ativas para esta plataforma. Cancele-as antes de desativar." });
        }
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("status", sql.VarChar, status)
          .query("UPDATE Plataforma SET status = @status, atualizado_em = SYSUTCDATETIME() WHERE id = @id");

        await registrarAuditoria(transaction, request.usuario!.sub, "alterar_status_plataforma", id, {
          statusAnterior: plataforma.status,
          statusNovo: status,
        });

        await transaction.commit();
        // S10 (SDD §3.4): plataforma.status_alterado — Central de Operações e demais
        // telas com a grade de status aberta atualizam sem F5.
        publicarEventoGlobal("plataforma.status_alterado", { id, status });
        const completa = await buscarPlataformaPorId(pool, id);
        return reply.status(200).send(await mapPlataforma(completa!));
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );
}
