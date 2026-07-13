import type { FastifyInstance } from "fastify";
import { criarPainelTokenSchema } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { autenticar, requireRole } from "../middlewares/rbac.js";
import { sqlStatusPlataformaDerivado } from "../services/plataforma.service.js";
import {
  gerarTokenDispositivo,
  hashTokenDispositivo,
  validarTokenDispositivo,
} from "../services/painelToken.service.js";

interface PainelTokenRow {
  id: string;
  nome: string;
  setor_id: string | null;
  setor_nome: string | null;
  ativo: boolean;
  criado_por_nome: string;
  criado_em: Date;
  ultimo_uso_em: Date | null;
}

function mapPainelToken(row: PainelTokenRow) {
  return {
    id: row.id,
    nome: row.nome,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    ativo: row.ativo,
    criadoPorNome: row.criado_por_nome,
    criadoEm: row.criado_em.toISOString(),
    ultimoUsoEm: row.ultimo_uso_em ? row.ultimo_uso_em.toISOString() : null,
  };
}

const SELECT_TOKEN = `
  pt.id, pt.nome, pt.setor_id, s.nome AS setor_nome, pt.ativo,
  u.nome AS criado_por_nome, pt.criado_em, pt.ultimo_uso_em`;
const FROM_TOKEN = `
  FROM PainelToken pt
  LEFT JOIN Setor s ON s.id = pt.setor_id
  JOIN Usuario u ON u.id = pt.criado_por_id`;

interface PainelReservaRow {
  id: string;
  plataforma_nome: string;
  setor_nome: string;
  hora_inicio: string;
  hora_fim: string;
  status: string;
}

function mapPainelReserva(row: PainelReservaRow) {
  return {
    id: row.id,
    plataformaNome: row.plataforma_nome,
    setorNome: row.setor_nome,
    horaInicio: row.hora_inicio,
    horaFim: row.hora_fim,
    status: row.status,
  };
}

// RF-TV-03: Admin gera/gerencia tokens de dispositivo do Painel TV, cada um escopado a
// um setor (ou a todos, quando setorId é nulo). RF-TV-01/02: dados públicos do painel,
// sem sessão de usuário — apenas o token de dispositivo válido.
export async function painelRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/painel/tokens",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const parsed = criarPainelTokenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const setorId = parsed.data.setorId ?? null;
      const pool = await getPool();

      if (setorId) {
        const setor = await pool
          .request()
          .input("id", sql.UniqueIdentifier, setorId)
          .query("SELECT id FROM Setor WHERE id = @id");
        if (setor.recordset.length === 0) {
          return reply.status(404).send({ erro: "Setor não encontrado." });
        }
      }

      const tokenPlano = gerarTokenDispositivo();
      const tokenHash = hashTokenDispositivo(tokenPlano);

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("nome", sql.NVarChar, parsed.data.nome)
          .input("token_hash", sql.Char(64), tokenHash)
          .input("setor_id", sql.UniqueIdentifier, setorId)
          .input("criado_por_id", sql.UniqueIdentifier, request.usuario!.sub)
          .query<{ id: string }>(
            `INSERT INTO PainelToken (nome, token_hash, setor_id, criado_por_id)
             OUTPUT INSERTED.id
             VALUES (@nome, @token_hash, @setor_id, @criado_por_id)`
          );
        const novoId = insercao.recordset[0].id;

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, novoId)
          .input("detalhes", sql.NVarChar, JSON.stringify({ nome: parsed.data.nome, setorId }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'criar_painel_token', 'PainelToken', @entidade_id, @detalhes)`
          );

        await transaction.commit();

        const completo = await pool
          .request()
          .input("id", sql.UniqueIdentifier, novoId)
          .query<PainelTokenRow>(`SELECT ${SELECT_TOKEN} ${FROM_TOKEN} WHERE pt.id = @id`);
        // Única resposta que expõe o token em texto puro — nunca mais recuperável depois.
        return reply.status(201).send({ ...mapPainelToken(completo.recordset[0]), token: tokenPlano });
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/painel/tokens",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (_request, reply) => {
      const pool = await getPool();
      const result = await pool
        .request()
        .query<PainelTokenRow>(`SELECT ${SELECT_TOKEN} ${FROM_TOKEN} ORDER BY pt.criado_em DESC`);
      return reply.status(200).send(result.recordset.map(mapPainelToken));
    }
  );

  app.delete(
    "/api/v1/painel/tokens/:id",
    { preHandler: [autenticar, requireRole(["admin"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const pool = await getPool();
      const atual = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query("SELECT id FROM PainelToken WHERE id = @id");
      if (atual.recordset.length === 0) {
        return reply.status(404).send({ erro: "Token não encontrado." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      try {
        await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query("UPDATE PainelToken SET ativo = 0 WHERE id = @id");
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, request.usuario!.sub)
          .input("entidade_id", sql.UniqueIdentifier, id)
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, 'revogar_painel_token', 'PainelToken', @entidade_id, '{}')`
          );
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
      return reply.status(204).send();
    }
  );

  app.get("/api/v1/painel/dados", async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.status(401).send({ erro: "Token de dispositivo ausente." });
    }
    const tokenValido = await validarTokenDispositivo(token);
    if (!tokenValido) {
      return reply.status(401).send({ erro: "Token de dispositivo inválido ou revogado." });
    }

    const pool = await getPool();

    // hora_inicio/hora_fim são horário local de parede (mesma convenção de
    // hora_inicio_real/hora_fim_real em reservas.ts, que usa GETDATE(), não
    // SYSUTCDATETIME()) — usado aqui para comparar consistentemente com "agora".
    const dbHoje = pool.request();
    let filtroSetor = "";
    if (tokenValido.setorId) {
      dbHoje.input("setor_id", sql.UniqueIdentifier, tokenValido.setorId);
      filtroSetor = " AND r.setor_id = @setor_id";
    }
    const reservasHoje = await dbHoje.query<PainelReservaRow>(
      `SELECT r.id, p.nome AS plataforma_nome, s.nome AS setor_nome,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim, r.status
       FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id JOIN Setor s ON s.id = r.setor_id
       WHERE r.data = CAST(GETDATE() AS DATE) AND r.status IN ('agendada', 'em_uso', 'concluida')${filtroSetor}
       ORDER BY r.hora_inicio ASC`
    );

    const dbProximas = pool.request();
    if (tokenValido.setorId) {
      dbProximas.input("setor_id", sql.UniqueIdentifier, tokenValido.setorId);
    }
    const proximasDuasHoras = await dbProximas.query<PainelReservaRow>(
      `SELECT r.id, p.nome AS plataforma_nome, s.nome AS setor_nome,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim, r.status
       FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id JOIN Setor s ON s.id = r.setor_id
       WHERE r.data = CAST(GETDATE() AS DATE) AND r.status = 'agendada'
         AND r.hora_inicio BETWEEN CONVERT(varchar(5), GETDATE(), 108) AND CONVERT(varchar(5), DATEADD(HOUR, 2, GETDATE()), 108)
         ${filtroSetor}
       ORDER BY r.hora_inicio ASC`
    );

    const plataformas = await pool.request().query<{ id: string; codigo: string; nome: string; status: string }>(
      `WITH PlataformaComStatus AS (
         SELECT p.id, p.codigo, p.nome, ${sqlStatusPlataformaDerivado("p")} AS status FROM Plataforma p
       )
       SELECT id, codigo, nome, status FROM PlataformaComStatus ORDER BY codigo`
    );

    return reply.status(200).send({
      atualizadoEm: new Date().toISOString(),
      reservasHoje: reservasHoje.recordset.map(mapPainelReserva),
      proximasDuasHoras: proximasDuasHoras.recordset.map(mapPainelReserva),
      plataformas: plataformas.recordset,
    });
  });
}
