import type { FastifyInstance } from "fastify";
import {
  atualizarComentarioSchema,
  criarComentarioSchema,
  MAX_IMAGENS_POR_COMENTARIO,
  MIMES_IMAGEM_COMENTARIO,
  type ImagemComentarioInput,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, usuarioEhAutorOuAdmin } from "../middlewares/rbac.js";
import type { JwtPayload } from "../utils/jwt.js";
import { registrarNotificacao, type NotificacaoRegistrada } from "../services/notificacao.service.js";
import { publicarEventoUsuario } from "../services/eventos.service.js";
import { enfileirarEmail } from "../services/queue.js";
import { templateComentarioNovo } from "../services/email.service.js";
import {
  armazenamentoService,
  ArquivoExcedeLimiteError,
  MimeNaoPermitidoError,
  urlDeLeitura,
} from "../services/storage.service.js";

/* Timeline operacional da reserva.
 *
 * Substitui a antiga separação "Anexos | Comentários". A imagem passa a pertencer ao
 * comentário que a explica — "essa foto é de qual observação?" deixa de ser uma pergunta
 * sem resposta —, e um comentário pode ser classificado como NÃO CONFORMIDADE, que é o
 * ponto único de registro do que deu errado na operação.
 *
 * Anexos e ocorrências gravados antes desta versão NÃO são migrados nem apagados: são
 * projetados na mesma timeline como entradas históricas somente-leitura (ver a UNION em
 * GET). Migrar arquivos entre tabelas para "limpar" o modelo destruiria a evidência de
 * quem enviou o quê e quando.
 */

interface ReservaComentarioContexto {
  id: string;
  setor_id: string;
  solicitante_id: string;
  plataforma_nome: string;
}

async function buscarContexto(id: string): Promise<ReservaComentarioContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaComentarioContexto>(
      `SELECT r.id, r.setor_id, r.solicitante_id, p.nome AS plataforma_nome
       FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

interface EntradaTimelineRow {
  id: string;
  reserva_id: string;
  usuario_id: string;
  usuario_nome: string;
  mensagem: string;
  tipo: string;
  criado_em: Date;
  atualizado_em: Date | null;
  /** null = comentário de verdade; preenchido = entrada histórica projetada. */
  origem_historica: "anexo" | "ocorrencia" | null;
  /** Só para entradas históricas de anexo — permite exibir/baixar o arquivo antigo. */
  historico_url_blob: string | null;
  historico_tipo_mime: string | null;
  historico_nome_arquivo: string | null;
}

interface ImagemRow {
  id: string;
  comentario_id: string;
  nome_arquivo: string;
  url_blob: string;
  tipo_mime: string;
}

/* UNION das três origens numa única linha do tempo, ordenada por data.
 *
 * Anexos e ocorrências entram com `origem_historica` preenchido — o frontend os marca
 * como entradas de histórico e não oferece edição. A ocorrência vira uma entrada do tipo
 * 'nao_conformidade', que é exatamente o conceito que ela sempre representou: o novo
 * modelo consolida os dois em vez de manter dois mecanismos concorrentes para reportar a
 * mesma coisa. */
const SELECT_TIMELINE = `
  SELECT c.id, c.reserva_id, c.usuario_id, u.nome AS usuario_nome, c.mensagem, c.tipo,
         c.criado_em, c.atualizado_em, CAST(NULL AS VARCHAR(20)) AS origem_historica,
         CAST(NULL AS NVARCHAR(500)) AS historico_url_blob,
         CAST(NULL AS VARCHAR(100)) AS historico_tipo_mime,
         CAST(NULL AS NVARCHAR(200)) AS historico_nome_arquivo
  FROM Comentario c JOIN Usuario u ON u.id = c.usuario_id
  WHERE c.reserva_id = @reserva_id AND c.excluido_em IS NULL

  UNION ALL

  SELECT a.id, a.reserva_id, a.enviado_por_id, u.nome, a.nome_arquivo, 'comentario',
         a.criado_em, CAST(NULL AS DATETIME2), 'anexo', a.url_blob, a.tipo_mime, a.nome_arquivo
  FROM Anexo a JOIN Usuario u ON u.id = a.enviado_por_id
  WHERE a.reserva_id = @reserva_id

  UNION ALL

  SELECT o.id, o.reserva_id, o.reportado_por_id, u.nome, o.descricao, 'nao_conformidade',
         o.criado_em, CAST(NULL AS DATETIME2), 'ocorrencia', NULL, NULL, NULL
  FROM Ocorrencia o JOIN Usuario u ON u.id = o.reportado_por_id
  WHERE o.reserva_id = @reserva_id

  ORDER BY criado_em ASC`;

async function montarTimeline(reservaId: string, usuario: Pick<JwtPayload, "perfil" | "sub">) {
  const pool = await getPool();
  const entradas = await pool
    .request()
    .input("reserva_id", sql.UniqueIdentifier, reservaId)
    .query<EntradaTimelineRow>(SELECT_TIMELINE);

  // Uma única consulta para TODAS as imagens da reserva, agrupadas em memória — não uma
  // consulta por comentário (N+1).
  const imagens = await pool
    .request()
    .input("reserva_id", sql.UniqueIdentifier, reservaId)
    .query<ImagemRow>(
      `SELECT i.id, i.comentario_id, i.nome_arquivo, i.url_blob, i.tipo_mime
       FROM ComentarioImagem i
       JOIN Comentario c ON c.id = i.comentario_id
       WHERE c.reserva_id = @reserva_id`
    );

  const porComentario = new Map<string, ImagemRow[]>();
  for (const imagem of imagens.recordset) {
    const lista = porComentario.get(imagem.comentario_id) ?? [];
    lista.push(imagem);
    porComentario.set(imagem.comentario_id, lista);
  }

  return Promise.all(
    entradas.recordset.map(async (linha) => {
      const proprias = porComentario.get(linha.id) ?? [];
      const imagensPublicas = await Promise.all(
        proprias.map(async (imagem) => ({
          id: imagem.id,
          nomeArquivo: imagem.nome_arquivo,
          tipoMime: imagem.tipo_mime,
          // A chave nunca sai da API — sempre URL de leitura assinada, de curta duração.
          url: urlDeLeitura(imagem.url_blob) ?? "",
        }))
      );

      // Anexo histórico que é imagem aparece como imagem do próprio registro; os demais
      // tipos (PDF, ART) ficam identificados pelo rótulo, sem miniatura.
      if (linha.origem_historica === "anexo" && linha.historico_url_blob) {
        const ehImagem = (MIMES_IMAGEM_COMENTARIO as readonly string[]).includes(
          linha.historico_tipo_mime ?? ""
        );
        if (ehImagem) {
          imagensPublicas.push({
            id: linha.id,
            nomeArquivo: linha.historico_nome_arquivo ?? "arquivo",
            tipoMime: linha.historico_tipo_mime ?? "",
            url: urlDeLeitura(linha.historico_url_blob) ?? "",
          });
        }
      }

      // Entradas históricas (anexo/ocorrência) nunca são editáveis/excluíveis por esta rota —
      // pertencem a outro modelo, sem PATCH/DELETE próprio nesta timeline.
      const ehComentarioReal = linha.origem_historica === null;
      const podeGerenciar = ehComentarioReal && usuarioEhAutorOuAdmin(usuario, linha.usuario_id);

      return {
        id: linha.id,
        reservaId: linha.reserva_id,
        usuarioId: linha.usuario_id,
        usuarioNome: linha.usuario_nome,
        mensagem: linha.mensagem,
        tipo: linha.tipo,
        imagens: imagensPublicas.filter((imagem) => imagem.url),
        criadoEm: linha.criado_em.toISOString(),
        atualizadoEm: linha.atualizado_em ? linha.atualizado_em.toISOString() : null,
        editado: linha.atualizado_em !== null,
        podeEditar: podeGerenciar,
        podeExcluir: podeGerenciar,
        historico: linha.origem_historica
          ? {
              origem: linha.origem_historica,
              rotulo:
                linha.origem_historica === "anexo"
                  ? "Arquivo anexado anteriormente"
                  : "Ocorrência registrada no formato anterior",
            }
          : null,
      };
    })
  );
}

class FormatoImagemInvalidoError extends Error {}

/* Upload de imagens do comentário — compartilhado por POST (criação) e PATCH (edição).
 *
 * Upload acontece ANTES de qualquer transação de banco, de propósito: gravar blobs dentro
 * dela manteria uma transação aberta durante I/O de rede, segurando locks por segundos. O
 * mime é verificado pelos BYTES reais (magic bytes, dentro de salvarArquivo), nunca pelo que
 * o cliente declarou no data URL nem pela extensão do nome.
 *
 * Se qualquer imagem do lote falhar, as que já tinham sido gravadas por ESTA chamada são
 * removidas antes de propagar o erro — sem isto, a segunda imagem inválida de três deixaria a
 * primeira órfã no storage. */
async function salvarImagensComentario(
  reservaId: string,
  imagens: ImagemComentarioInput[]
): Promise<Array<{ nome: string; url: string; mime: string; bytes: number }>> {
  const salvos: Array<{ nome: string; url: string; mime: string; bytes: number }> = [];
  try {
    for (const imagem of imagens) {
      const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(imagem.arquivoBase64);
      if (!match) {
        throw new FormatoImagemInvalidoError("Formato de imagem inválido.");
      }
      const [, mimeDeclarado, conteudo] = match;
      if (!(MIMES_IMAGEM_COMENTARIO as readonly string[]).includes(mimeDeclarado)) {
        throw new FormatoImagemInvalidoError("Envie uma imagem JPEG, PNG ou WebP.");
      }
      const salvo = await armazenamentoService.salvarArquivo(
        `reservas/${reservaId}/comentarios`,
        Buffer.from(conteudo, "base64"),
        mimeDeclarado
      );
      // Segunda barreira: o conteúdo real precisa ser imagem de um dos formatos aceitos,
      // mesmo que o cabeçalho declarado tenha passado.
      if (!(MIMES_IMAGEM_COMENTARIO as readonly string[]).includes(salvo.tipoMimeReal)) {
        await armazenamentoService.excluirArquivo(salvo.url).catch(() => undefined);
        throw new FormatoImagemInvalidoError("O arquivo enviado não é uma imagem JPEG, PNG ou WebP.");
      }
      salvos.push({ nome: imagem.nomeArquivo, url: salvo.url, mime: salvo.tipoMimeReal, bytes: salvo.tamanhoBytes });
    }
    return salvos;
  } catch (err) {
    await Promise.all(salvos.map((s) => armazenamentoService.excluirArquivo(s.url).catch(() => undefined)));
    throw err;
  }
}

export async function comentariosRoutes(app: FastifyInstance): Promise<void> {
  // Leitura E criação são globais (mesma política de disponibilidade/listagem de reservas):
  // qualquer usuário autenticado pode ver e comentar em qualquer reserva — é conteúdo
  // operacional compartilhado, não pessoal. Só editar/excluir um comentário já existente
  // continua restrito a quem o escreveu (ou admin) via usuarioEhAutorOuAdmin, abaixo.
  app.get("/api/v1/reservas/:id/comentarios", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContexto(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    return reply.status(200).send(await montarTimeline(id, request.usuario!));
  });

  app.post("/api/v1/reservas/:id/comentarios", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = criarComentarioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const contexto = await buscarContexto(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }

    const { mensagem, tipo, imagens } = parsed.data;
    const autorId = request.usuario!.sub;
    const pool = await getPool();

    let salvos: Array<{ nome: string; url: string; mime: string; bytes: number }>;
    try {
      salvos = await salvarImagensComentario(id, imagens);
    } catch (err) {
      if (err instanceof FormatoImagemInvalidoError || err instanceof MimeNaoPermitidoError || err instanceof ArquivoExcedeLimiteError) {
        return reply.status(422).send({ erro: err.message });
      }
      throw err;
    }

    // Participantes da conversa: solicitante + quem já comentou, exceto o autor atual.
    const participantes = await pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, id)
      .input("autor_id", sql.UniqueIdentifier, autorId)
      .input("solicitante_id", sql.UniqueIdentifier, contexto.solicitante_id)
      .query<{ id: string; email: string }>(
        `SELECT DISTINCT u.id, u.email FROM Usuario u
         WHERE u.id IN (
           SELECT c.usuario_id FROM Comentario c WHERE c.reserva_id = @reserva_id
           UNION SELECT @solicitante_id
         ) AND u.id <> @autor_id`
      );

    const transaction = pool.transaction();
    await transaction.begin();
    let novoId: string;
    const notificacoes: NotificacaoRegistrada[] = [];
    try {
      const insercao = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .input("usuario_id", sql.UniqueIdentifier, autorId)
        .input("mensagem", sql.NVarChar, mensagem)
        .input("tipo", sql.VarChar, tipo)
        .query<{ id: string }>(
          `INSERT INTO Comentario (reserva_id, usuario_id, mensagem, tipo)
           OUTPUT INSERTED.id
           VALUES (@reserva_id, @usuario_id, @mensagem, @tipo)`
        );
      novoId = insercao.recordset[0].id;

      // Toda não conformidade nasce com o registro de tratamento (status 'aberta' por
      // default) na mesma transação — nunca existe um Comentario tipo='nao_conformidade'
      // sem a linha 1:1 correspondente em NaoConformidade (ver migration 0021).
      if (tipo === "nao_conformidade") {
        await transaction
          .request()
          .input("comentario_id", sql.UniqueIdentifier, novoId)
          .query(`INSERT INTO NaoConformidade (comentario_id) VALUES (@comentario_id)`);
      }

      for (const salvo of salvos) {
        await transaction
          .request()
          .input("comentario_id", sql.UniqueIdentifier, novoId)
          .input("nome_arquivo", sql.NVarChar, salvo.nome)
          .input("url_blob", sql.NVarChar, salvo.url)
          .input("tipo_mime", sql.VarChar, salvo.mime)
          .input("tamanho_bytes", sql.Int, salvo.bytes)
          .query(
            `INSERT INTO ComentarioImagem (comentario_id, nome_arquivo, url_blob, tipo_mime, tamanho_bytes)
             VALUES (@comentario_id, @nome_arquivo, @url_blob, @tipo_mime, @tamanho_bytes)`
          );
      }

      /* Não conformidade recebe evento de auditoria próprio: "o que deu errado nesta
         operação?" precisa ser respondível pela Auditoria sem varrer toda a timeline.
         Marcar como NC NÃO altera a plataforma, não cancela a reserva e não bloqueia a
         conclusão — o requisito aqui é registrar e identificar, não disparar automação. */
      const acaoAuditoria = tipo === "nao_conformidade" ? "registrar_nao_conformidade" : "comentar_reserva";
      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, autorId)
        .input("acao", sql.VarChar, acaoAuditoria)
        .input("entidade_id", sql.UniqueIdentifier, novoId)
        .input("detalhes", sql.NVarChar, JSON.stringify({ reservaId: id, tipo, totalImagens: salvos.length }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, 'Comentario', @entidade_id, @detalhes)`
        );

      const autorNome = (
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, autorId)
          .query<{ nome: string }>("SELECT nome FROM Usuario WHERE id = @id")
      ).recordset[0].nome;

      const ehNaoConformidade = tipo === "nao_conformidade";
      const resumo = mensagem.trim() || `${salvos.length} imagem(ns)`;
      for (const participante of participantes.recordset) {
        notificacoes.push(
          await registrarNotificacao(transaction, {
            usuarioId: participante.id,
            tipo: "comentario_novo",
            titulo: ehNaoConformidade ? "Não conformidade registrada" : "Novo comentário",
            mensagem: `${autorNome} ${ehNaoConformidade ? "registrou uma não conformidade" : "comentou"} na reserva de ${contexto.plataforma_nome}: "${resumo.slice(0, 100)}"`,
            link: `/reservas/${id}`,
          })
        );
      }

      await transaction.commit();

      for (const notificacao of notificacoes) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
      }

      const { assunto, corpoHtml } = templateComentarioNovo({
        plataformaNome: contexto.plataforma_nome,
        autorNome,
        mensagem: ehNaoConformidade ? `[NÃO CONFORMIDADE] ${resumo}` : resumo,
      });
      await Promise.all(
        participantes.recordset.map((p) => enfileirarEmail({ destinatario: p.email, assunto, corpoHtml }))
      );
    } catch (err) {
      await transaction.rollback();
      // Blobs já gravados perdem o registro que os referenciava — removidos best-effort
      // para não deixar lixo no storage.
      await Promise.all(salvos.map((s) => armazenamentoService.excluirArquivo(s.url).catch(() => undefined)));
      throw err;
    }

    const timeline = await montarTimeline(id, request.usuario!);
    return reply.status(201).send(timeline.find((entrada) => entrada.id === novoId) ?? null);
  });

  app.patch(
    "/api/v1/reservas/:id/comentarios/:comentarioId",
    { preHandler: autenticar },
    async (request, reply) => {
      const { id, comentarioId } = request.params as { id: string; comentarioId: string };
      const parsed = atualizarComentarioSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }

      const contexto = await buscarContexto(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, comentarioId)
        .input("reserva_id", sql.UniqueIdentifier, id)
        .query<{ id: string; usuario_id: string; tipo: string; excluido_em: Date | null }>(
          `SELECT id, usuario_id, tipo, excluido_em FROM Comentario WHERE id = @id AND reserva_id = @reserva_id`
        );
      const comentario = atual.recordset[0];
      if (!comentario || comentario.excluido_em) {
        return reply.status(404).send({ erro: "Comentário não encontrado." });
      }
      if (!usuarioEhAutorOuAdmin(request.usuario!, comentario.usuario_id)) {
        return reply.status(403).send({ erro: "Você só pode editar seus próprios comentários." });
      }

      const imagensAtuais = await pool
        .request()
        .input("comentario_id", sql.UniqueIdentifier, comentarioId)
        .query<{ id: string; url_blob: string }>(
          `SELECT id, url_blob FROM ComentarioImagem WHERE comentario_id = @comentario_id`
        );
      const idsAtuais = new Set(imagensAtuais.recordset.map((linha) => linha.id));
      // Ignora silenciosamente ids que não pertencem mais a este comentário (já removidos
      // por outra edição concorrente) em vez de erro — o resultado final é o mesmo.
      const idsRemover = parsed.data.imagensRemover.filter((imgId) => idsAtuais.has(imgId));
      const totalFinalImagens = imagensAtuais.recordset.length - idsRemover.length + parsed.data.imagensAdicionar.length;
      if (totalFinalImagens > MAX_IMAGENS_POR_COMENTARIO) {
        return reply.status(422).send({ erro: `Máximo de ${MAX_IMAGENS_POR_COMENTARIO} imagens por comentário.` });
      }

      const mensagem = parsed.data.mensagem.trim();
      // Mesma regra do schema de criação (RN-COM-01) — reaplicada aqui porque a contagem
      // final de imagens só é conhecida depois de ler o estado atual no banco.
      if (comentario.tipo === "nao_conformidade" && mensagem.length < 3) {
        return reply.status(422).send({ erro: "Descreva a não conformidade antes de salvar." });
      }
      if (mensagem.length === 0 && totalFinalImagens === 0) {
        return reply.status(422).send({ erro: "Escreva um comentário ou mantenha ao menos uma imagem." });
      }

      let salvos: Array<{ nome: string; url: string; mime: string; bytes: number }>;
      try {
        salvos = await salvarImagensComentario(id, parsed.data.imagensAdicionar);
      } catch (err) {
        if (err instanceof FormatoImagemInvalidoError || err instanceof MimeNaoPermitidoError || err instanceof ArquivoExcedeLimiteError) {
          return reply.status(422).send({ erro: err.message });
        }
        throw err;
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, comentarioId)
          .input("mensagem", sql.NVarChar, mensagem)
          .query(`UPDATE Comentario SET mensagem = @mensagem, atualizado_em = SYSUTCDATETIME() WHERE id = @id`);

        for (const imgId of idsRemover) {
          await transaction
            .request()
            .input("id", sql.UniqueIdentifier, imgId)
            .query(`DELETE FROM ComentarioImagem WHERE id = @id`);
        }
        for (const salvo of salvos) {
          await transaction
            .request()
            .input("comentario_id", sql.UniqueIdentifier, comentarioId)
            .input("nome_arquivo", sql.NVarChar, salvo.nome)
            .input("url_blob", sql.NVarChar, salvo.url)
            .input("tipo_mime", sql.VarChar, salvo.mime)
            .input("tamanho_bytes", sql.Int, salvo.bytes)
            .query(
              `INSERT INTO ComentarioImagem (comentario_id, nome_arquivo, url_blob, tipo_mime, tamanho_bytes)
               VALUES (@comentario_id, @nome_arquivo, @url_blob, @tipo_mime, @tamanho_bytes)`
            );
        }
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, comentarioId)
          .input("detalhes", sql.NVarChar, JSON.stringify({ reservaId: id }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'editar_comentario', 'Comentario', @entidade_id, @detalhes)`
          );
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        await Promise.all(salvos.map((s) => armazenamentoService.excluirArquivo(s.url).catch(() => undefined)));
        throw err;
      }

      // Blobs das imagens removidas — best-effort, fora da transação (o dado relacional já
      // está consistente; o binário no storage é só liberação de espaço).
      const blobsRemovidos = imagensAtuais.recordset
        .filter((linha) => idsRemover.includes(linha.id))
        .map((linha) => linha.url_blob);
      await Promise.all(blobsRemovidos.map((url) => armazenamentoService.excluirArquivo(url).catch(() => undefined)));

      const timeline = await montarTimeline(id, request.usuario!);
      return reply.status(200).send(timeline.find((entrada) => entrada.id === comentarioId) ?? null);
    }
  );

  app.delete(
    "/api/v1/reservas/:id/comentarios/:comentarioId",
    { preHandler: autenticar },
    async (request, reply) => {
      const { id, comentarioId } = request.params as { id: string; comentarioId: string };

      const contexto = await buscarContexto(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, comentarioId)
        .input("reserva_id", sql.UniqueIdentifier, id)
        .query<{ id: string; usuario_id: string; excluido_em: Date | null }>(
          `SELECT id, usuario_id, excluido_em FROM Comentario WHERE id = @id AND reserva_id = @reserva_id`
        );
      const comentario = atual.recordset[0];
      if (!comentario || comentario.excluido_em) {
        return reply.status(404).send({ erro: "Comentário não encontrado." });
      }
      if (!usuarioEhAutorOuAdmin(request.usuario!, comentario.usuario_id)) {
        return reply.status(403).send({ erro: "Você só pode excluir seus próprios comentários." });
      }

      const imagens = await pool
        .request()
        .input("comentario_id", sql.UniqueIdentifier, comentarioId)
        .query<{ url_blob: string }>(`SELECT url_blob FROM ComentarioImagem WHERE comentario_id = @comentario_id`);

      // Soft delete — nada é apagado do relacional (mesma postura do resto do domínio desde
      // a migration 0018). A UI passa a filtrar pelo GET, que já ignora excluido_em IS NOT
      // NULL; a linha (e sua NaoConformidade, se houver) continuam existindo para auditoria.
      await pool
        .request()
        .input("id", sql.UniqueIdentifier, comentarioId)
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .query(
          `UPDATE Comentario SET excluido_em = SYSUTCDATETIME(), excluido_por = @usuario_id WHERE id = @id`
        );

      await pool
        .request()
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("entidade_id", sql.UniqueIdentifier, comentarioId)
        .input("detalhes", sql.NVarChar, JSON.stringify({ reservaId: id }))
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'excluir_comentario', 'Comentario', @entidade_id, @detalhes)`
        );

      // Blobs das imagens — best-effort. A linha ComentarioImagem fica (evidência de nome/
      // tamanho/tipo), só o binário no storage é liberado.
      await Promise.all(imagens.recordset.map((linha) => armazenamentoService.excluirArquivo(linha.url_blob).catch(() => undefined)));

      return reply.status(204).send();
    }
  );
}
