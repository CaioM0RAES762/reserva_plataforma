import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  atualizarStatusPlataformaSchema,
  criarPlataformaSchema,
  editarPlataformaSchema,
  horimetroAtualHoras,
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
  telefone_emergencia: string | null;
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
  horimetro_uso_minutos: number;
  utilizacao_30d: number | null;
  evento_texto: string | null;
  evento_detalhe: string | null;
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
    telefoneEmergencia: row.telefone_emergencia,
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
    // Baseline (cadastro/correção) + uso real contabilizado pelas reservas (migration 0022).
    horimetroHoras: row.horimetro_horas,
    horimetroUsoMinutos: row.horimetro_uso_minutos ?? 0,
    horimetroAtualHoras: horimetroAtualHoras(row.horimetro_horas, row.horimetro_uso_minutos ?? 0),
    utilizacao30d: row.utilizacao_30d,
    evento: row.evento_texto ? { texto: row.evento_texto, detalhe: row.evento_detalhe } : null,
    // NR-18/NR-35 continuam derivadas de categoria/altura: são informação de segurança do
    // equipamento em si, independentes do checklist que saiu do fluxo de reserva.
    normas: calcularNormasPlataforma(row.categoria, row.altura_maxima_m),
    inicioAutomaticoPadrao: row.inicio_automatico_padrao,
    fimAutomaticoPadrao: row.fim_automatico_padrao,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const SELECT_COLUNAS =
  "id, codigo, nome, localizacao, telefone_emergencia, capacidade, status, categoria, risco, aprovacao_automatica, " +
  "observacoes, imagem_url, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas, horimetro_uso_minutos, " +
  "utilizacao_30d, evento_texto, evento_detalhe, inicio_automatico_padrao, fim_automatico_padrao, " +
  "criado_em, atualizado_em";

// CTE reutilizada pela listagem e por buscarPlataformaPorId (recarrega o registro
// completo, com os campos computados, depois de um INSERT/UPDATE) — evita duplicar a
// lógica de status derivado, utilização e evento em destaque em três lugares.
function buildQueryPlataformas(whereEOrder: string): string {
  return `
    WITH PlataformaComStatus AS (
      SELECT p.id, p.codigo, p.nome, p.localizacao, p.telefone_emergencia, p.capacidade,
             ${sqlStatusPlataformaDerivado("p")} AS status,
             p.categoria, p.risco, p.aprovacao_automatica, p.observacoes, p.imagem_url,
             p.tipo_equipamento, p.altura_maxima_m, p.capacidade_operadores, p.horimetro_horas,
             p.horimetro_uso_minutos,
             ${sqlUtilizacao30dPlataforma("p")} AS utilizacao_30d,
             evento_ativo.texto AS evento_texto, evento_ativo.detalhe AS evento_detalhe,
             p.inicio_automatico_padrao, p.fim_automatico_padrao,
             p.criado_em, p.atualizado_em
      FROM Plataforma p
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
          // Campo vazio no formulário significa "não informado" — grava NULL, nunca "".
          .input("telefone_emergencia", sql.NVarChar, parsed.data.telefoneEmergencia?.trim() || null)
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .query(
            // exige_checklist / checklist_template_id saíram do INSERT junto com o
            // acoplamento entre checklist e reserva. As colunas continuam na tabela
            // (migration 0018 não as remove) para não invalidar o histórico já gravado,
            // mas nenhuma escrita nova as define — ficam no default 0/NULL.
            `INSERT INTO Plataforma (
               id, codigo, nome, localizacao, capacidade, categoria, risco, aprovacao_automatica,
               observacoes, imagem_url, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas,
               telefone_emergencia, inicio_automatico_padrao, fim_automatico_padrao
             )
             VALUES (
               @id, @codigo, @nome, @localizacao, @capacidade, @categoria, @risco, @aprovacao_automatica,
               @observacoes, @imagem_url, @tipo_equipamento, @altura_maxima_m, @capacidade_operadores, @horimetro_horas,
               @telefone_emergencia, @inicio_automatico_padrao, @fim_automatico_padrao
             )`
          );

        await registrarAuditoria(transaction, request.usuario!.sub, "criar_plataforma", novoId, {
          codigo,
          nome: parsed.data.nome,
          telefoneEmergencia: parsed.data.telefoneEmergencia?.trim() || null,
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
        .query<{ id: string; imagem_url: string | null; telefone_emergencia: string | null }>(
          "SELECT id, imagem_url, telefone_emergencia FROM Plataforma WHERE id = @id"
        );
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }
      const imagemAnteriorBlob = atual.recordset[0].imagem_url;
      // Lido ANTES do UPDATE para poder comparar e só auditar quando o número realmente muda.
      const telefoneEmergenciaAnterior = atual.recordset[0].telefone_emergencia;
      const telefoneEmergenciaNovo = parsed.data.telefoneEmergencia?.trim() || null;

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
          .input("telefone_emergencia", sql.NVarChar, telefoneEmergenciaNovo)
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .query(
            // horimetro_horas NÃO é gravado aqui: o horímetro é automático, e reenviar o formulário
            // não pode sobrescrever o uso acumulado. Mudança de valor é uma correção explícita,
            // tratada logo abaixo (com lock na linha e auditoria própria).
            `UPDATE Plataforma SET
               codigo = @codigo, nome = @nome, localizacao = @localizacao,
               capacidade = @capacidade, categoria = @categoria, risco = @risco,
               aprovacao_automatica = @aprovacao_automatica, observacoes = @observacoes,
               imagem_url = @imagem_url, tipo_equipamento = @tipo_equipamento,
               altura_maxima_m = @altura_maxima_m, capacidade_operadores = @capacidade_operadores,
               telefone_emergencia = @telefone_emergencia,
               inicio_automatico_padrao = @inicio_automatico_padrao,
               fim_automatico_padrao = @fim_automatico_padrao,
               atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );

        await registrarAuditoria(transaction, request.usuario!.sub, "editar_plataforma", id, {
          codigo,
          nome: parsed.data.nome,
        });

        /* Correção manual do horímetro (Admin). O formulário envia o horímetro atual em horas
           inteiras; só há correção quando o valor DIFERE do atual. Corrigir redefine o
           baseline e zera o uso acumulado (que passa a estar contido no valor informado).
           UPDLOCK: uma conclusão de reserva simultânea espera — o incremento dela não se perde
           entre a leitura e a gravação. */
        if (parsed.data.horimetroHoras !== undefined) {
          const horimetro = await transaction
            .request()
            .input("id", sql.UniqueIdentifier, id)
            .query<{ horimetro_horas: number | null; horimetro_uso_minutos: number }>(
              "SELECT horimetro_horas, horimetro_uso_minutos FROM Plataforma WITH (UPDLOCK, ROWLOCK) WHERE id = @id"
            );
          const { horimetro_horas: baseAnterior, horimetro_uso_minutos: usoAnterior } = horimetro.recordset[0];
          const atualHoras = horimetroAtualHoras(baseAnterior, usoAnterior);
          const novoValor = parsed.data.horimetroHoras;
          if (atualHoras === null || Math.floor(atualHoras) !== novoValor) {
            await transaction
              .request()
              .input("id", sql.UniqueIdentifier, id)
              .input("horimetro_horas", sql.Int, novoValor)
              .query("UPDATE Plataforma SET horimetro_horas = @horimetro_horas, horimetro_uso_minutos = 0 WHERE id = @id");
            await registrarAuditoria(transaction, request.usuario!.sub, "corrigir_horimetro", id, {
              codigo,
              horimetroAnteriorHoras: atualHoras,
              horimetroNovoHoras: novoValor,
              baselineAnteriorHoras: baseAnterior,
              usoIncorporadoMinutos: usoAnterior,
            });
          }
        }

        /* Telefone de emergência ganha evento PRÓPRIO quando muda. É o número que alguém
           vai discar no pior momento possível: "quem trocou isso e quando?" precisa ser
           respondível sem abrir o payload de um evento genérico de edição. */
        if (telefoneEmergenciaAnterior !== telefoneEmergenciaNovo) {
          await registrarAuditoria(transaction, request.usuario!.sub, "atualizar_telefone_emergencia", id, {
            codigo,
            telefoneAnterior: telefoneEmergenciaAnterior,
            telefoneNovo: telefoneEmergenciaNovo,
          });
        }

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
