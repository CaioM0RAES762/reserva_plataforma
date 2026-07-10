import { getPool, sql } from "../db/pool.js";
import { enfileirarEmail } from "./queue.js";
import { templateEscalonamentoSla } from "./email.service.js";

const ACAO_ESCALONAMENTO = "escalonar_sla_urgente";

interface ReservaCandidataRow {
  id: string;
  plataforma_nome: string;
  data: string;
  hora_inicio: string;
  hora_fim: string;
}

async function buscarSlaHoras(pool: Awaited<ReturnType<typeof getPool>>): Promise<number> {
  const result = await pool
    .request()
    .query<{ valor: string }>("SELECT valor FROM ConfiguracaoSistema WHERE chave = 'sla_aprovacao_urgente_horas'");
  const valor = result.recordset[0]?.valor;
  return valor ? Number(valor) : 2;
}

// RN-RES-09: verifica reservas `urgente` ainda `pendente` (sem decisão final) há mais
// tempo que `sla_aprovacao_urgente_horas` e escala ao(s) Admin(s) — uma única vez por
// reserva, usando LogAuditoria como marcador de idempotência (nenhuma coluna nova
// necessária). Retorna os IDs das reservas escaladas nesta execução, para permitir
// asserção direta em testes de integração sem depender do agendamento real do BullMQ.
export async function verificarEscalonamentoSla(): Promise<string[]> {
  const pool = await getPool();
  const slaHoras = await buscarSlaHoras(pool);

  const candidatas = await pool.request().input("sla_minutos", sql.Int, slaHoras * 60).query<ReservaCandidataRow>(
    `SELECT r.id, p.nome AS plataforma_nome,
            CONVERT(varchar(10), r.data, 23) AS data,
            CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
            CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim
     FROM Reserva r
     JOIN Plataforma p ON p.id = r.plataforma_id
     WHERE r.prioridade = 'urgente'
       AND r.status = 'pendente'
       AND DATEDIFF(MINUTE, r.criado_em, SYSUTCDATETIME()) >= @sla_minutos
       AND NOT EXISTS (
         SELECT 1 FROM LogAuditoria la
         WHERE la.entidade = 'Reserva' AND la.entidade_id = r.id AND la.acao = '${ACAO_ESCALONAMENTO}'
       )`
  );

  const admins = await pool
    .request()
    .query<{ email: string }>("SELECT email FROM Usuario WHERE perfil = 'admin' AND ativo = 1");

  const escaladas: string[] = [];
  for (const reserva of candidatas.recordset) {
    await pool
      .request()
      .input("acao", sql.VarChar, ACAO_ESCALONAMENTO)
      .input("entidade_id", sql.UniqueIdentifier, reserva.id)
      .input("detalhes", sql.NVarChar, JSON.stringify({ slaHoras }))
      .query(
        `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
         VALUES (NULL, @acao, 'Reserva', @entidade_id, @detalhes)`
      );

    const { assunto, corpoHtml } = templateEscalonamentoSla({
      plataformaNome: reserva.plataforma_nome,
      data: reserva.data,
      horaInicio: reserva.hora_inicio,
      horaFim: reserva.hora_fim,
      slaHoras,
    });
    await Promise.all(
      admins.recordset.map((admin) => enfileirarEmail({ destinatario: admin.email, assunto, corpoHtml }))
    );

    escaladas.push(reserva.id);
  }

  return escaladas;
}
