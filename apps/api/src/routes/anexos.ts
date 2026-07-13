import type { FastifyInstance } from "fastify";
import { criarAnexoSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, usuarioNoEscopoDaReserva } from "../middlewares/rbac.js";
import { armazenamentoService, ArquivoExcedeLimiteError, MimeNaoPermitidoError } from "../services/storage.service.js";

interface ReservaEscopoRow {
  id: string;
  setor_id: string;
}

async function buscarReservaEscopo(id: string): Promise<ReservaEscopoRow | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaEscopoRow>("SELECT id, setor_id FROM Reserva WHERE id = @id");
  return result.recordset[0] ?? null;
}

interface AnexoRow {
  id: string;
  reserva_id: string;
  nome_arquivo: string;
  url_blob: string;
  tipo_mime: string;
  tamanho_bytes: number;
  enviado_por_id: string;
  enviado_por_nome: string;
  criado_em: Date;
}

async function mapAnexo(row: AnexoRow) {
  return {
    id: row.id,
    reservaId: row.reserva_id,
    nomeArquivo: row.nome_arquivo,
    tipoMime: row.tipo_mime,
    tamanhoBytes: row.tamanho_bytes,
    enviadoPorId: row.enviado_por_id,
    enviadoPorNome: row.enviado_por_nome,
    url: await armazenamentoService.gerarUrlAcesso(row.url_blob),
    criadoEm: row.criado_em.toISOString(),
  };
}

// RF-RES-14: anexos (foto, PDF, ART) por reserva — restrito ao escopo da própria
// reserva/setor do usuário (Admin sem restrição), mesmo padrão de checklist.ts (S8).
export async function anexosRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/reservas/:id/anexos", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const reserva = await buscarReservaEscopo(id);
    if (!reserva) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, reserva.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode consultar anexos de reservas do seu próprio setor." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("reserva_id", sql.UniqueIdentifier, id)
      .query<AnexoRow>(
        `SELECT a.id, a.reserva_id, a.nome_arquivo, a.url_blob, a.tipo_mime, a.tamanho_bytes,
                a.enviado_por_id, u.nome AS enviado_por_nome, a.criado_em
         FROM Anexo a JOIN Usuario u ON u.id = a.enviado_por_id
         WHERE a.reserva_id = @reserva_id ORDER BY a.criado_em DESC`
      );
    return reply.status(200).send(await Promise.all(result.recordset.map(mapAnexo)));
  });

  app.post("/api/v1/reservas/:id/anexos", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = criarAnexoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    const reserva = await buscarReservaEscopo(id);
    if (!reserva) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!usuarioNoEscopoDaReserva(request.usuario!, reserva.setor_id)) {
      return reply.status(403).send({ erro: "Você só pode anexar arquivos a reservas do seu próprio setor." });
    }

    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(parsed.data.arquivoBase64);
    if (!match) {
      return reply.status(422).send({ erro: "Formato de arquivo inválido." });
    }
    const [, mimeDeclarado, conteudo] = match;
    const buffer = Buffer.from(conteudo, "base64");

    let salvo;
    try {
      salvo = await armazenamentoService.salvarArquivo(`reservas/${id}`, parsed.data.nomeArquivo, buffer, mimeDeclarado);
    } catch (err) {
      if (err instanceof MimeNaoPermitidoError || err instanceof ArquivoExcedeLimiteError) {
        return reply.status(422).send({ erro: err.message });
      }
      throw err;
    }

    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    let novoId: string;
    try {
      const insercao = await transaction
        .request()
        .input("reserva_id", sql.UniqueIdentifier, id)
        .input("nome_arquivo", sql.NVarChar, parsed.data.nomeArquivo)
        .input("url_blob", sql.NVarChar, salvo.url)
        .input("tipo_mime", sql.VarChar, salvo.tipoMimeReal)
        .input("tamanho_bytes", sql.Int, salvo.tamanhoBytes)
        .input("enviado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
        .query<{ id: string }>(
          `INSERT INTO Anexo (reserva_id, nome_arquivo, url_blob, tipo_mime, tamanho_bytes, enviado_por_id)
           OUTPUT INSERTED.id
           VALUES (@reserva_id, @nome_arquivo, @url_blob, @tipo_mime, @tamanho_bytes, @enviado_por_id)`
        );
      novoId = insercao.recordset[0].id;

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
        .input("entidade_id", sql.UniqueIdentifier, novoId)
        .input(
          "detalhes",
          sql.NVarChar,
          JSON.stringify({ reservaId: id, nomeArquivo: parsed.data.nomeArquivo, tipoMime: salvo.tipoMimeReal, tamanhoBytes: salvo.tamanhoBytes })
        )
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, 'anexar_arquivo', 'Anexo', @entidade_id, @detalhes)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const completo = await pool
      .request()
      .input("id", sql.UniqueIdentifier, novoId)
      .query<AnexoRow>(
        `SELECT a.id, a.reserva_id, a.nome_arquivo, a.url_blob, a.tipo_mime, a.tamanho_bytes,
                a.enviado_por_id, u.nome AS enviado_por_nome, a.criado_em
         FROM Anexo a JOIN Usuario u ON u.id = a.enviado_por_id
         WHERE a.id = @id`
      );
    return reply.status(201).send(await mapAnexo(completo.recordset[0]));
  });
}
