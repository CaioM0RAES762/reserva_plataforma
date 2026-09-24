import type { FastifyInstance } from "fastify";
import {
  atualizarStatusNaoConformidadeSchema,
  naoConformidadeFiltroQuerySchema,
  resolverPaginacao,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { gerarUrlAcessoOuNulo } from "../services/storage.service.js";

/* Área "Não Conformidades" (sidebar, sob OPERAÇÃO).
 *
 * A origem do dado continua sendo o comentário marcado como não conformidade
 * (Comentario.tipo='nao_conformidade', criado em POST /reservas/:id/comentarios) — esta
 * rota só agrega essas entradas entre reservas, com o status de tratamento
 * (NaoConformidade, migration 0021). Descrição/imagens/reserva não são duplicadas: quem
 * quiser o contexto completo tem "Ver reserva" para abrir a timeline original.
 */

interface UsuarioSessaoNc {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

// Mesmo critério de resolverEscopoSetor (relatorios.ts)/RF-HIST-01: Gestor de Setor
// sempre restrito ao próprio setor, mesmo enviando ?setor=<outro>; só o Admin filtra
// livremente ou vê o agregado global.
function resolverEscopoSetorNc(usuario: UsuarioSessaoNc, setorQuery: string | undefined): string | null {
  if (usuario.perfil === "admin") return setorQuery ?? null;
  return usuario.setorId;
}

interface NaoConformidadeRow {
  id: string;
  status: "aberta" | "em_analise" | "resolvida";
  criado_em: Date;
  resolvido_em: Date | null;
  mensagem: string;
  autor_id: string;
  autor_nome: string;
  reserva_id: string;
  setor_id: string;
  setor_nome: string;
  plataforma_id: string;
  plataforma_nome: string;
}

const SELECT_NC = `
  SELECT c.id, nc.status, c.criado_em, nc.resolvido_em, c.mensagem,
         c.usuario_id AS autor_id, u.nome AS autor_nome,
         r.id AS reserva_id, r.setor_id, s.nome AS setor_nome,
         r.plataforma_id, p.nome AS plataforma_nome`;
const FROM_NC = `
  FROM Comentario c
  JOIN NaoConformidade nc ON nc.comentario_id = c.id
  JOIN Usuario u ON u.id = c.usuario_id
  JOIN Reserva r ON r.id = c.reserva_id
  JOIN Plataforma p ON p.id = r.plataforma_id
  JOIN Setor s ON s.id = r.setor_id`;

async function imagensDoComentario(comentarioId: string) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("comentario_id", sql.UniqueIdentifier, comentarioId)
    .query<{ id: string; nome_arquivo: string; url_blob: string; tipo_mime: string }>(
      `SELECT id, nome_arquivo, url_blob, tipo_mime FROM ComentarioImagem WHERE comentario_id = @comentario_id`
    );
  return Promise.all(
    result.recordset.map(async (imagem) => ({
      id: imagem.id,
      nomeArquivo: imagem.nome_arquivo,
      tipoMime: imagem.tipo_mime,
      url: (await gerarUrlAcessoOuNulo(imagem.url_blob)) ?? "",
    }))
  );
}

function mapRow(row: NaoConformidadeRow, imagens: Awaited<ReturnType<typeof imagensDoComentario>>) {
  return {
    id: row.id,
    status: row.status,
    criadoEm: row.criado_em.toISOString(),
    resolvidoEm: row.resolvido_em ? row.resolvido_em.toISOString() : null,
    descricao: row.mensagem,
    imagens: imagens.filter((imagem) => imagem.url),
    autorId: row.autor_id,
    autorNome: row.autor_nome,
    reservaId: row.reserva_id,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    plataformaId: row.plataforma_id,
    plataformaNome: row.plataforma_nome,
  };
}

export async function naoConformidadesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/nao-conformidades", { preHandler: autenticar }, async (request, reply) => {
    const parsed = naoConformidadeFiltroQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    const usuario = request.usuario!;
    const escopoSetorId = resolverEscopoSetorNc(usuario, parsed.data.setor);

    const pool = await getPool();
    const dbRequest = pool.request();
    let where = "c.tipo = 'nao_conformidade' AND c.excluido_em IS NULL";
    if (escopoSetorId) {
      dbRequest.input("setor_id", sql.UniqueIdentifier, escopoSetorId);
      where += " AND r.setor_id = @setor_id";
    }
    if (parsed.data.plataforma) {
      dbRequest.input("plataforma_id", sql.UniqueIdentifier, parsed.data.plataforma);
      where += " AND r.plataforma_id = @plataforma_id";
    }
    if (parsed.data.responsavel) {
      dbRequest.input("responsavel_id", sql.UniqueIdentifier, parsed.data.responsavel);
      where += " AND c.usuario_id = @responsavel_id";
    }
    if (parsed.data.status) {
      dbRequest.input("status", sql.VarChar, parsed.data.status);
      where += " AND nc.status = @status";
    }
    if (parsed.data.dateFrom) {
      dbRequest.input("date_from", sql.Date, parsed.data.dateFrom);
      where += " AND c.criado_em >= @date_from";
    }
    if (parsed.data.dateTo) {
      dbRequest.input("date_to", sql.Date, parsed.data.dateTo);
      where += " AND c.criado_em < DATEADD(DAY, 1, CAST(@date_to AS DATETIME2))";
    }
    if (parsed.data.texto) {
      dbRequest.input("texto", sql.NVarChar, `%${parsed.data.texto}%`);
      where += " AND c.mensagem LIKE @texto";
    }

    const { limit, offset } = resolverPaginacao(parsed.data);
    dbRequest.input("limit", sql.Int, limit).input("offset", sql.Int, offset);

    const result = await dbRequest.query<NaoConformidadeRow & { total_geral: number }>(
      `${SELECT_NC}, COUNT(*) OVER() AS total_geral ${FROM_NC}
       WHERE ${where}
       ORDER BY c.criado_em DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    );
    const total = result.recordset[0]?.total_geral ?? 0;

    // Imagens buscadas por item (a listagem é paginada — no máximo `limit` comentários por
    // página, nunca a tabela inteira), não é o mesmo risco de N+1 de uma tela sem paginação.
    const itens = await Promise.all(
      result.recordset.map(async (row) => mapRow(row, await imagensDoComentario(row.id)))
    );

    return reply
      .header("X-Total-Count", String(total))
      .header("X-Limit", String(limit))
      .header("X-Offset", String(offset))
      .status(200)
      .send(itens);
  });

  app.get("/api/v1/nao-conformidades/:id", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query<NaoConformidadeRow>(
        `${SELECT_NC} ${FROM_NC} WHERE c.id = @id AND c.tipo = 'nao_conformidade' AND c.excluido_em IS NULL`
      );
    const row = result.recordset[0];
    if (!row) {
      return reply.status(404).send({ erro: "Não conformidade não encontrada." });
    }

    const usuario = request.usuario!;
    if (usuario.perfil !== "admin" && usuario.setorId !== row.setor_id) {
      return reply.status(403).send({ erro: "Você só pode consultar não conformidades do seu próprio setor." });
    }

    return reply.status(200).send(mapRow(row, await imagensDoComentario(row.id)));
  });

  app.patch(
    "/api/v1/nao-conformidades/:id/status",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = atualizarStatusNaoConformidadeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ id: string; setor_id: string; status: string }>(
          `SELECT nc.id, r.setor_id, nc.status
           FROM Comentario c
           JOIN NaoConformidade nc ON nc.comentario_id = c.id
           JOIN Reserva r ON r.id = c.reserva_id
           WHERE c.id = @id AND c.tipo = 'nao_conformidade' AND c.excluido_em IS NULL`
        );
      const registro = atual.recordset[0];
      if (!registro) {
        return reply.status(404).send({ erro: "Não conformidade não encontrada." });
      }

      const usuario = request.usuario!;
      if (usuario.perfil !== "admin" && usuario.setorId !== registro.setor_id) {
        return reply.status(403).send({ erro: "Você só pode tratar não conformidades do seu próprio setor." });
      }

      const novoStatus = parsed.data.status;
      const resolvendoAgora = novoStatus === "resolvida";
      // resolvido_em/resolvido_por só fazem sentido junto de 'resolvida' — voltar para
      // aberta/em_analise limpa os dois (não é "resolvida de novo depois", é "reaberta").
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, registro.id)
        .input("status", sql.VarChar, novoStatus)
        .input("resolvido_por", sql.UniqueIdentifier, resolvendoAgora ? usuario.sub : null)
        .query(
          `UPDATE NaoConformidade
           SET status = @status,
               resolvido_em = ${resolvendoAgora ? "SYSUTCDATETIME()" : "NULL"},
               resolvido_por = @resolvido_por,
               atualizado_em = SYSUTCDATETIME()
           WHERE id = @id`
        );

      await pool
        .request()
        .input("usuario_id", sql.UniqueIdentifier, usuario.sub)
        .input("entidade_id", sql.UniqueIdentifier, id)
        .input("detalhes", sql.NVarChar, JSON.stringify({ statusAnterior: registro.status, statusNovo: novoStatus }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'atualizar_status_nao_conformidade', 'Comentario', @entidade_id, @detalhes)`
        );

      const atualizado = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<NaoConformidadeRow>(`${SELECT_NC} ${FROM_NC} WHERE c.id = @id`);
      return reply.status(200).send(mapRow(atualizado.recordset[0], await imagensDoComentario(id)));
    }
  );
}
