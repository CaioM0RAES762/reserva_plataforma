import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  adicionarImagemPlataformaSchema,
  atualizarStatusPlataformaSchema,
  criarPlataformaSchema,
  editarPlataformaSchema,
  horimetroAtualHoras,
  LIMITE_IMAGENS_PLATAFORMA,
  MIMES_IMAGEM_PLATAFORMA,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import type { JwtPayload } from "../utils/jwt.js";
import {
  avaliarGestaoPlataforma,
  MENSAGEM_SEM_GESTAO_PLATAFORMA,
  origemGestaoPlataforma,
  plataformasDoResponsavel,
  type UsuarioGestao,
} from "../services/gestaoPlataforma.service.js";
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
  FormatoImagemNaoPermitidoError,
  MimeNaoPermitidoError,
  urlDeLeitura,
  validarImagemDataUrl,
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
  categoria_nome: string | null;
  categoria_ativa: boolean | null;
  marca: string | null;
  risco: string;
  aprovacao_automatica: boolean;
  observacoes: string | null;
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
  criado_por_id: string | null;
  setor_id: string | null;
  setor_nome: string | null;
  criado_em: Date;
  atualizado_em: Date;
}

interface ImagemRow {
  id: string;
  plataforma_id: string;
  blob_path: string;
  ordem: number;
  principal: boolean;
}

/* Imagens de uma ou de todas as plataformas, na ordem de exibição (principal = ordem 0).
   Uma consulta só para a listagem inteira — no máximo 4 linhas por plataforma. */
async function buscarImagens(
  executor: { request: () => sql.Request },
  plataformaId?: string
): Promise<Map<string, ImagemRow[]>> {
  const req = executor.request();
  let where = "";
  if (plataformaId) {
    req.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
    where = "WHERE plataforma_id = @plataforma_id";
  }
  const result = await req.query<ImagemRow>(
    `SELECT id, plataforma_id, blob_path, ordem, principal FROM PlataformaImagem ${where} ORDER BY plataforma_id, ordem`
  );
  const mapa = new Map<string, ImagemRow[]>();
  for (const img of result.recordset) {
    const chave = img.plataforma_id.toLowerCase();
    mapa.set(chave, [...(mapa.get(chave) ?? []), img]);
  }
  return mapa;
}

function mapPlataforma(
  row: PlataformaRow,
  usuario: UsuarioGestao,
  responsavelPor: Set<string>,
  imagensRows: ImagemRow[] = []
) {
  const origemGestao = origemGestaoPlataforma(usuario, {
    criadoPorId: row.criado_por_id,
    setorId: row.setor_id,
    ehResponsavel: responsavelPor.has(row.id.toLowerCase()),
  });
  // A chave do arquivo nunca sai da API — sempre convertida em URL de leitura assinada.
  const imagens = imagensRows.map((img) => ({
    id: img.id.toLowerCase(),
    url: urlDeLeitura(img.blob_path),
    ordem: img.ordem,
    principal: img.principal,
  }));
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    localizacao: row.localizacao,
    telefoneEmergencia: row.telefone_emergencia,
    capacidade: row.capacidade,
    status: row.status,
    categoria: row.categoria,
    categoriaNome: row.categoria_nome,
    categoriaAtiva: row.categoria_ativa ?? false,
    marca: row.marca,
    risco: row.risco,
    aprovacaoAutomatica: row.aprovacao_automatica,
    observacoes: row.observacoes,
    // Capa = imagem principal. Derivada da galeria (fonte única), mantida por compatibilidade
    // com as telas que só mostram uma imagem.
    imagemUrl: imagens.find((i) => i.principal)?.url ?? null,
    imagens,
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
    criadoPorId: row.criado_por_id,
    // Setor responsável (migration 0030); null em plataformas antigas ainda sem atribuição.
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    // Decidido aqui, com a MESMA regra das rotas de escrita (gestaoPlataforma.service) — a tela
    // só mostra/esconde Editar/Desativar conforme estes campos, nunca recalcula a permissão.
    podeEditar: origemGestao !== null,
    origemGestao,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

const SELECT_COLUNAS =
  "id, codigo, nome, localizacao, telefone_emergencia, capacidade, status, categoria, categoria_nome, categoria_ativa, " +
  "marca, risco, aprovacao_automatica, observacoes, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas, horimetro_uso_minutos, " +
  "utilizacao_30d, evento_texto, evento_detalhe, inicio_automatico_padrao, fim_automatico_padrao, " +
  "criado_por_id, setor_id, setor_nome, criado_em, atualizado_em";

// CTE reutilizada pela listagem e por buscarPlataformaPorId (recarrega o registro
// completo, com os campos computados, depois de um INSERT/UPDATE) — evita duplicar a
// lógica de status derivado, utilização e evento em destaque em três lugares.
function buildQueryPlataformas(whereEOrder: string): string {
  return `
    WITH PlataformaComStatus AS (
      SELECT p.id, p.codigo, p.nome, p.localizacao, p.telefone_emergencia, p.capacidade,
             ${sqlStatusPlataformaDerivado("p")} AS status,
             p.categoria, cat.nome AS categoria_nome, cat.ativo AS categoria_ativa, p.marca,
             p.risco, p.aprovacao_automatica, p.observacoes,
             p.tipo_equipamento, p.altura_maxima_m, p.capacidade_operadores, p.horimetro_horas,
             p.horimetro_uso_minutos,
             ${sqlUtilizacao30dPlataforma("p")} AS utilizacao_30d,
             evento_ativo.texto AS evento_texto, evento_ativo.detalhe AS evento_detalhe,
             p.inicio_automatico_padrao, p.fim_automatico_padrao,
             p.criado_por_id, p.setor_id, setor.nome AS setor_nome, p.criado_em, p.atualizado_em
      FROM Plataforma p
      LEFT JOIN CategoriaEquipamento cat ON cat.codigo = p.categoria
      LEFT JOIN Setor setor ON setor.id = p.setor_id
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

async function responsavelPorDe(
  pool: Awaited<ReturnType<typeof getPool>>,
  usuario: UsuarioGestao
): Promise<Set<string>> {
  // Só Gestor ganha algo com a atribuição direta; para os demais nem consulta.
  return usuario.perfil === "gestor_setor" ? plataformasDoResponsavel(pool, usuario.sub) : new Set();
}

async function carregarPlataformaCompleta(
  pool: Awaited<ReturnType<typeof getPool>>,
  id: string,
  usuario: UsuarioGestao
) {
  const [row, imagens, responsavelPor] = await Promise.all([
    buscarPlataformaPorId(pool, id),
    buscarImagens(pool, id),
    responsavelPorDe(pool, usuario),
  ]);
  return mapPlataforma(row!, usuario, responsavelPor, imagens.get(id.toLowerCase()));
}

// Admin e Gestor de Setor passam pelo requireRole das rotas de escrita; QUAL plataforma o Gestor
// gerencia (criador, setor ou responsável direto) é decidido por avaliarGestaoPlataforma, contra
// o banco, antes de qualquer gravação.
const PERFIS_GESTAO_PLATAFORMA: JwtPayload["perfil"][] = ["admin", "gestor_setor"];

// Responde 404/403 quando a gestão não é permitida e devolve false; true = pode seguir.
async function garantirEdicaoPlataforma(
  pool: Awaited<ReturnType<typeof getPool>>,
  id: string,
  usuario: UsuarioGestao,
  reply: import("fastify").FastifyReply
): Promise<boolean> {
  const avaliacao = await avaliarGestaoPlataforma(pool, usuario, id);
  if (!avaliacao) {
    await reply.status(404).send({ erro: "Plataforma não encontrada." });
    return false;
  }
  if (!avaliacao.origem) {
    await reply.status(403).send({ erro: MENSAGEM_SEM_GESTAO_PLATAFORMA });
    return false;
  }
  return true;
}

/* Setor responsável informado pelo Admin: precisa existir e estar ativo. */
async function validarSetorResponsavel(
  pool: Awaited<ReturnType<typeof getPool>>,
  setorId: string
): Promise<string | null> {
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, setorId)
    .query<{ ativo: boolean }>("SELECT ativo FROM Setor WHERE id = @id");
  if (!r.recordset[0]) return "Setor responsável inválido.";
  if (!r.recordset[0].ativo) return "Setor responsável inativo — escolha um setor ativo.";
  return null;
}

/* Categoria precisa existir em CategoriaEquipamento e estar ATIVA — exceto quando é a que a
   plataforma já usa (categoria desativada depois continua valendo para quem já a tinha). */
async function validarCategoria(
  pool: Awaited<ReturnType<typeof getPool>>,
  categoria: string,
  categoriaAtual: string | null
): Promise<string | null> {
  const result = await pool
    .request()
    .input("codigo", sql.VarChar, categoria)
    .query<{ ativo: boolean }>("SELECT ativo FROM CategoriaEquipamento WHERE codigo = @codigo");
  const cat = result.recordset[0];
  if (!cat) return "Categoria inválida.";
  if (!cat.ativo && categoria !== categoriaAtual) return "Categoria desativada — escolha uma categoria ativa.";
  return null;
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
      where += " AND (nome LIKE @q OR codigo LIKE @q OR localizacao LIKE @q OR marca LIKE @q)";
    }
    if (status) {
      dbRequest.input("status", sql.VarChar, status);
      where += " AND status = @status";
    }

    const [result, imagens] = await Promise.all([
      dbRequest.query<PlataformaRow>(buildQueryPlataformas(`${where} ORDER BY codigo`)),
      buscarImagens(pool),
    ]);
    const usuario = request.usuario!;
    const responsavelPor = await responsavelPorDe(pool, usuario);
    return reply
      .status(200)
      .send(
        result.recordset.map((row) => mapPlataforma(row, usuario, responsavelPor, imagens.get(row.id.toLowerCase())))
      );
  });

  app.post(
    "/api/v1/plataformas",
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
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

      const erroCategoria = await validarCategoria(pool, parsed.data.categoria, null);
      if (erroCategoria) return reply.status(422).send({ erro: erroCategoria });

      // Setor responsável (migration 0030): o Gestor cadastra SEMPRE para o próprio setor atual
      // (o que vier no corpo é ignorado — ele não escolhe); o Admin escolhe e é obrigatório.
      const usuarioAtual = request.usuario!;
      let setorResponsavelId: string;
      if (usuarioAtual.perfil === "gestor_setor") {
        if (!usuarioAtual.setorId) {
          return reply.status(422).send({ erro: "Sua conta não está vinculada a um setor; peça ao Admin para definir o seu setor." });
        }
        setorResponsavelId = usuarioAtual.setorId;
      } else {
        if (!parsed.data.setorId) {
          return reply.status(422).send({
            erro: "Selecione o setor responsável pela plataforma.",
            detalhes: { formErrors: [], fieldErrors: { setorId: ["Selecione o setor responsável."] } },
          });
        }
        const erroSetor = await validarSetorResponsavel(pool, parsed.data.setorId);
        if (erroSetor) return reply.status(422).send({ erro: erroSetor });
        setorResponsavelId = parsed.data.setorId;
      }

      // Imagens entram depois, uma a uma, em POST /plataformas/:id/imagens.
      const novoId = randomUUID();
      const marca = parsed.data.marca?.trim() || null;

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
          .input("marca", sql.NVarChar, marca)
          .input("tipo_equipamento", sql.NVarChar, parsed.data.tipoEquipamento ?? null)
          .input("altura_maxima_m", sql.Decimal(4, 1), parsed.data.alturaMaximaM ?? null)
          .input("capacidade_operadores", sql.Int, parsed.data.capacidadeOperadores ?? null)
          .input("horimetro_horas", sql.Int, parsed.data.horimetroHoras ?? null)
          // Campo vazio no formulário significa "não informado" — grava NULL, nunca "".
          .input("telefone_emergencia", sql.NVarChar, parsed.data.telefoneEmergencia?.trim() || null)
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .input("criado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("setor_id", sql.UniqueIdentifier, setorResponsavelId)
          .query(
            // exige_checklist / checklist_template_id saíram do INSERT junto com o
            // acoplamento entre checklist e reserva. As colunas continuam na tabela
            // (migration 0018 não as remove) para não invalidar o histórico já gravado,
            // mas nenhuma escrita nova as define — ficam no default 0/NULL.
            `INSERT INTO Plataforma (
               id, codigo, nome, localizacao, capacidade, categoria, risco, aprovacao_automatica,
               observacoes, marca, tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas,
               telefone_emergencia, inicio_automatico_padrao, fim_automatico_padrao, criado_por_id, setor_id
             )
             VALUES (
               @id, @codigo, @nome, @localizacao, @capacidade, @categoria, @risco, @aprovacao_automatica,
               @observacoes, @marca, @tipo_equipamento, @altura_maxima_m, @capacidade_operadores, @horimetro_horas,
               @telefone_emergencia, @inicio_automatico_padrao, @fim_automatico_padrao, @criado_por_id, @setor_id
             )`
          );

        await registrarAuditoria(transaction, request.usuario!.sub, "criar_plataforma", novoId, {
          codigo,
          setorId: setorResponsavelId,
          nome: parsed.data.nome,
          categoria: parsed.data.categoria,
          marca,
          telefoneEmergencia: parsed.data.telefoneEmergencia?.trim() || null,
        });

        await transaction.commit();
        return reply.status(201).send(await carregarPlataformaCompleta(pool, novoId, request.usuario!));
      } catch (err) {
        await transaction.rollback();
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
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
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
        .query<{
          id: string;
          categoria: string;
          marca: string | null;
          telefone_emergencia: string | null;
        }>("SELECT id, categoria, marca, telefone_emergencia FROM Plataforma WHERE id = @id");
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }
      const avaliacao = await avaliarGestaoPlataforma(pool, request.usuario!, id);
      if (!avaliacao?.origem) {
        return reply.status(403).send({ erro: MENSAGEM_SEM_GESTAO_PLATAFORMA });
      }
      // Setor responsável: só o Admin altera. Plataforma antiga sem setor exige a escolha na
      // primeira edição do Admin; o Gestor edita os dados mas não muda o setor.
      const setorAnterior = avaliacao.setorId;
      let setorNovo = setorAnterior;
      if (request.usuario!.perfil === "admin") {
        if (parsed.data.setorId) {
          const erroSetor = await validarSetorResponsavel(pool, parsed.data.setorId);
          if (erroSetor) return reply.status(422).send({ erro: erroSetor });
          setorNovo = parsed.data.setorId;
        } else if (!setorAnterior) {
          return reply.status(422).send({
            erro: "Selecione o setor responsável pela plataforma.",
            detalhes: { formErrors: [], fieldErrors: { setorId: ["Selecione o setor responsável."] } },
          });
        }
      } else if (parsed.data.setorId && parsed.data.setorId.toLowerCase() !== (setorAnterior ?? "").toLowerCase()) {
        return reply.status(403).send({ erro: "Somente o Admin altera o setor responsável da plataforma." });
      }
      // Categoria desativada continua válida para quem JÁ a usa — só não pode ser escolhida de novo.
      const erroCategoria = await validarCategoria(pool, parsed.data.categoria, atual.recordset[0].categoria);
      if (erroCategoria) return reply.status(422).send({ erro: erroCategoria });
      const marcaAnterior = atual.recordset[0].marca;
      const marcaNova = parsed.data.marca?.trim() || null;
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
          .input("marca", sql.NVarChar, marcaNova)
          .input("tipo_equipamento", sql.NVarChar, parsed.data.tipoEquipamento ?? null)
          .input("altura_maxima_m", sql.Decimal(4, 1), parsed.data.alturaMaximaM ?? null)
          .input("capacidade_operadores", sql.Int, parsed.data.capacidadeOperadores ?? null)
          .input("telefone_emergencia", sql.NVarChar, telefoneEmergenciaNovo)
          .input("inicio_automatico_padrao", sql.Bit, parsed.data.inicioAutomaticoPadrao)
          .input("fim_automatico_padrao", sql.Bit, parsed.data.fimAutomaticoPadrao)
          .input("setor_id", sql.UniqueIdentifier, setorNovo)
          .query(
            // horimetro_horas NÃO é gravado aqui: o horímetro é automático, e reenviar o formulário
            // não pode sobrescrever o uso acumulado. Mudança de valor é uma correção explícita,
            // tratada logo abaixo (com lock na linha e auditoria própria).
            `UPDATE Plataforma SET
               codigo = @codigo, nome = @nome, localizacao = @localizacao,
               capacidade = @capacidade, categoria = @categoria, risco = @risco,
               aprovacao_automatica = @aprovacao_automatica, observacoes = @observacoes,
               marca = @marca, tipo_equipamento = @tipo_equipamento,
               altura_maxima_m = @altura_maxima_m, capacidade_operadores = @capacidade_operadores,
               telefone_emergencia = @telefone_emergencia,
               inicio_automatico_padrao = @inicio_automatico_padrao,
               fim_automatico_padrao = @fim_automatico_padrao,
               setor_id = @setor_id,
               atualizado_em = SYSUTCDATETIME()
             WHERE id = @id`
          );

        await registrarAuditoria(transaction, request.usuario!.sub, "editar_plataforma", id, {
          codigo,
          nome: parsed.data.nome,
          categoria: parsed.data.categoria,
        });

        if ((setorAnterior ?? "").toLowerCase() !== (setorNovo ?? "").toLowerCase()) {
          await registrarAuditoria(transaction, request.usuario!.sub, "alterar_setor_plataforma", id, {
            codigo,
            setorAnteriorId: setorAnterior,
            setorNovoId: setorNovo,
          });
        }

        if (marcaAnterior !== marcaNova) {
          await registrarAuditoria(transaction, request.usuario!.sub, "alterar_marca_plataforma", id, {
            codigo,
            marcaAnterior,
            marcaNova,
          });
        }

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
        return reply.status(200).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
      } catch (err) {
        await transaction.rollback();
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
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
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
        .query<{ id: string; status: string }>("SELECT id, status FROM Plataforma WHERE id = @id");
      const plataforma = atual.recordset[0];
      if (!plataforma) {
        return reply.status(404).send({ erro: "Plataforma não encontrada." });
      }
      if (!(await garantirEdicaoPlataforma(pool, id, request.usuario!, reply))) return reply;

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
        return reply.status(200).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // Galeria (migration 0025): até 4 imagens, uma operação por requisição. Cada upload é
  // independente — se a 3ª falhar, a 1ª e a 2ª continuam salvas, e reenviar só a que
  // falhou não duplica nada. Todas respondem com a plataforma completa (galeria atual).
  // -------------------------------------------------------------------------

  app.post(
    "/api/v1/plataformas/:id/imagens",
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_REGEX.test(id)) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      const parsed = adicionarImagemPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const pool = await getPool();

      const plataforma = await buscarIdentificacao(pool, id);
      if (!plataforma) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      if (!(await garantirEdicaoPlataforma(pool, id, request.usuario!, reply))) return reply;
      // Checagem barata ANTES do upload (evita subir um arquivo que seria recusado); a
      // garantia de verdade é a contagem com lock abaixo + CHECK/UNIQUE do banco.
      const total = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ n: number }>("SELECT COUNT(*) AS n FROM PlataformaImagem WHERE plataforma_id = @id");
      if (total.recordset[0].n >= LIMITE_IMAGENS_PLATAFORMA) {
        return reply.status(409).send({ erro: MENSAGEM_LIMITE_IMAGENS });
      }

      const blobPath = await enviarImagemOuResponder(reply, id, parsed.data.imagemBase64);
      if (!blobPath) return reply;

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const existentes = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query<{ ordem: number }>(
            "SELECT ordem FROM PlataformaImagem WITH (UPDLOCK, HOLDLOCK) WHERE plataforma_id = @id ORDER BY ordem"
          );
        if (existentes.recordset.length >= LIMITE_IMAGENS_PLATAFORMA) {
          await transaction.rollback();
          await armazenamentoService.excluirArquivo(blobPath).catch(() => undefined);
          return reply.status(409).send({ erro: MENSAGEM_LIMITE_IMAGENS });
        }
        const ordem = existentes.recordset.length;
        const principal = ordem === 0;
        const imagemId = randomUUID();
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .input("blob_path", sql.NVarChar, blobPath)
          .input("ordem", sql.Int, ordem)
          .input("principal", sql.Bit, principal)
          .input("criado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .query(
            `INSERT INTO PlataformaImagem (id, plataforma_id, blob_path, ordem, principal, criado_por_id)
             VALUES (@id, @plataforma_id, @blob_path, @ordem, @principal, @criado_por_id)`
          );
        await registrarAuditoria(transaction, request.usuario!.sub, "adicionar_imagem_plataforma", id, {
          ...plataforma,
          imagemId,
          posicao: ordem + 1,
          principal,
        });
        await transaction.commit();
        return reply.status(201).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        await armazenamentoService.excluirArquivo(blobPath).catch(() => undefined);
        const sqlErr = err as { number?: number };
        // Dois uploads simultâneos disputando a mesma posição: o banco recusa o 5º.
        if (sqlErr.number && CONFLITO_UNIQUE_SQL_ERROS.has(sqlErr.number)) {
          return reply.status(409).send({ erro: MENSAGEM_LIMITE_IMAGENS });
        }
        throw err;
      }
    }
  );

  // Substituir: mesma posição e mesmo papel (principal ou não), arquivo novo.
  app.put(
    "/api/v1/plataformas/:id/imagens/:imagemId",
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
    async (request, reply) => {
      const { id, imagemId } = request.params as { id: string; imagemId: string };
      if (!UUID_REGEX.test(id) || !UUID_REGEX.test(imagemId)) {
        return reply.status(404).send({ erro: "Imagem não encontrada." });
      }
      const parsed = adicionarImagemPlataformaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const pool = await getPool();
      const plataforma = await buscarIdentificacao(pool, id);
      if (!plataforma) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      if (!(await garantirEdicaoPlataforma(pool, id, request.usuario!, reply))) return reply;

      const blobPath = await enviarImagemOuResponder(reply, id, parsed.data.imagemBase64);
      if (!blobPath) return reply;

      const transaction = pool.transaction();
      await transaction.begin();
      let blobAnterior: string;
      try {
        const atual = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .query<{ blob_path: string; ordem: number; principal: boolean }>(
            `SELECT blob_path, ordem, principal FROM PlataformaImagem WITH (UPDLOCK)
             WHERE id = @id AND plataforma_id = @plataforma_id`
          );
        const imagem = atual.recordset[0];
        if (!imagem) {
          await transaction.rollback();
          await armazenamentoService.excluirArquivo(blobPath).catch(() => undefined);
          return reply.status(404).send({ erro: "Imagem não encontrada." });
        }
        blobAnterior = imagem.blob_path;
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .input("blob_path", sql.NVarChar, blobPath)
          .query("UPDATE PlataformaImagem SET blob_path = @blob_path, criado_em = SYSUTCDATETIME() WHERE id = @id");
        await registrarAuditoria(transaction, request.usuario!.sub, "substituir_imagem_plataforma", id, {
          ...plataforma,
          imagemId,
          posicao: imagem.ordem + 1,
          principal: imagem.principal,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        await armazenamentoService.excluirArquivo(blobPath).catch(() => undefined);
        throw err;
      }
      // Arquivo antigo só sai do storage depois do commit (best-effort, sem órfão no caminho feliz).
      await armazenamentoService.excluirArquivo(blobAnterior).catch(() => undefined);
      return reply.status(200).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
    }
  );

  app.delete(
    "/api/v1/plataformas/:id/imagens/:imagemId",
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
    async (request, reply) => {
      const { id, imagemId } = request.params as { id: string; imagemId: string };
      if (!UUID_REGEX.test(id) || !UUID_REGEX.test(imagemId)) {
        return reply.status(404).send({ erro: "Imagem não encontrada." });
      }
      const pool = await getPool();
      const plataforma = await buscarIdentificacao(pool, id);
      if (!plataforma) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      if (!(await garantirEdicaoPlataforma(pool, id, request.usuario!, reply))) return reply;

      const transaction = pool.transaction();
      await transaction.begin();
      let blobRemovido: string;
      try {
        const atual = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .query<{ blob_path: string; ordem: number; principal: boolean }>(
            `SELECT blob_path, ordem, principal FROM PlataformaImagem WITH (UPDLOCK)
             WHERE id = @id AND plataforma_id = @plataforma_id`
          );
        const imagem = atual.recordset[0];
        if (!imagem) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Imagem não encontrada." });
        }
        blobRemovido = imagem.blob_path;
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .query("DELETE FROM PlataformaImagem WHERE id = @id");
        // Ordem volta a ser contígua (0..n-1) e a 1ª passa a ser a principal — se a removida
        // era a principal, a seguinte assume a capa.
        await reordenarGaleria(transaction, id, null);
        await registrarAuditoria(transaction, request.usuario!.sub, "remover_imagem_plataforma", id, {
          ...plataforma,
          imagemId,
          posicao: imagem.ordem + 1,
          eraPrincipal: imagem.principal,
        });
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
      await armazenamentoService.excluirArquivo(blobRemovido).catch(() => undefined);
      return reply.status(200).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
    }
  );

  // A principal vai para a posição 1 (capa); as demais mantêm a ordem relativa.
  app.patch(
    "/api/v1/plataformas/:id/imagens/:imagemId/principal",
    { preHandler: [autenticar, requireRole(PERFIS_GESTAO_PLATAFORMA)] },
    async (request, reply) => {
      const { id, imagemId } = request.params as { id: string; imagemId: string };
      if (!UUID_REGEX.test(id) || !UUID_REGEX.test(imagemId)) {
        return reply.status(404).send({ erro: "Imagem não encontrada." });
      }
      const pool = await getPool();
      const plataforma = await buscarIdentificacao(pool, id);
      if (!plataforma) return reply.status(404).send({ erro: "Plataforma não encontrada." });
      if (!(await garantirEdicaoPlataforma(pool, id, request.usuario!, reply))) return reply;

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const atual = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, imagemId)
          .input("plataforma_id", sql.UniqueIdentifier, id)
          .query<{ principal: boolean }>(
            `SELECT principal FROM PlataformaImagem WITH (UPDLOCK, HOLDLOCK)
             WHERE id = @id AND plataforma_id = @plataforma_id`
          );
        const imagem = atual.recordset[0];
        if (!imagem) {
          await transaction.rollback();
          return reply.status(404).send({ erro: "Imagem não encontrada." });
        }
        if (!imagem.principal) {
          await reordenarGaleria(transaction, id, imagemId);
          await registrarAuditoria(transaction, request.usuario!.sub, "definir_imagem_principal", id, {
            ...plataforma,
            imagemId,
          });
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
      return reply.status(200).send(await carregarPlataformaCompleta(pool, id, request.usuario!));
    }
  );
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENSAGEM_LIMITE_IMAGENS = `Limite de ${LIMITE_IMAGENS_PLATAFORMA} imagens atingido.`;

// Snapshot de identificação para a auditoria (a plataforma pode ser renomeada depois).
async function buscarIdentificacao(
  pool: Awaited<ReturnType<typeof getPool>>,
  id: string
): Promise<{ codigo: string; nome: string } | null> {
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<{ codigo: string; nome: string }>("SELECT codigo, nome FROM Plataforma WHERE id = @id");
  return result.recordset[0] ?? null;
}

/* Valida (JPG/PNG/WEBP por magic bytes, até 10 MB) e grava no armazenamento FORA da transação,
   mesmo padrão de anexos. Em caso de arquivo recusado já responde 422 e devolve null. */
async function enviarImagemOuResponder(
  reply: import("fastify").FastifyReply,
  plataformaId: string,
  imagemBase64: string
): Promise<string | null> {
  let validada: { buffer: Buffer; mimeReal: string };
  try {
    validada = validarImagemDataUrl(imagemBase64, MIMES_IMAGEM_PLATAFORMA);
  } catch (err) {
    if (
      err instanceof FormatoImagemNaoPermitidoError ||
      err instanceof ArquivoExcedeLimiteError ||
      err instanceof MimeNaoPermitidoError
    ) {
      await reply.status(422).send({ erro: err.message });
      return null;
    }
    await reply.status(422).send({ erro: "Formato de imagem inválido." });
    return null;
  }
  // Pasta em minúsculas: o id pode chegar em maiúsculas (GUID do SQL Server) e a pasta física
  // precisa ser a mesma em Windows e Linux.
  const salvo = await armazenamentoService.salvarArquivo(
    `plataformas/${plataformaId.toLowerCase()}`,
    validada.buffer,
    validada.mimeReal
  );
  return salvo.url;
}

/* Renumera a galeria para 0..n-1 numa única instrução (o UNIQUE de ordem e o índice filtrado
   da principal são verificados no fim do statement). `primeiraId` = imagem que deve virar a
   principal; null = mantém a ordem atual. A principal é sempre a de ordem 0. */
async function reordenarGaleria(transaction: sql.Transaction, plataformaId: string, primeiraId: string | null) {
  await transaction
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("primeira_id", sql.UniqueIdentifier, primeiraId)
    .query(
      `WITH ordenada AS (
         SELECT ordem, principal,
                ROW_NUMBER() OVER (ORDER BY CASE WHEN id = @primeira_id THEN 0 ELSE 1 END, ordem) - 1 AS nova
         FROM PlataformaImagem WHERE plataforma_id = @plataforma_id
       )
       UPDATE ordenada SET ordem = nova, principal = CASE WHEN nova = 0 THEN 1 ELSE 0 END`
    );
}
