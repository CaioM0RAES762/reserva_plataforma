import type { FastifyInstance } from "fastify";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";
import { sqlStatusPlataformaDerivado } from "../services/plataforma.service.js";
import { agoraEmBrasilia } from "../services/automacaoReserva.service.js";
import { SELECT_RESERVA, FROM_RESERVA, mapReserva, type ReservaRow } from "./reservas.js";

type Perfil = "admin" | "gestor_setor" | "colaborador";

// Escopo por setor — hoje só no contador de não conformidades. Agenda do dia, KPIs de
// reservas e pendências são OPERACIONAIS e globais para todos os perfis (ver rotas abaixo);
// "Minhas próximas" é pessoal (filtrada por solicitante, não por setor).
function aplicarEscopoSetor(
  dbRequest: ReturnType<Awaited<ReturnType<typeof getPool>>["request"]>,
  perfil: Perfil,
  setorId: string | null,
  alias: string
): string {
  if (perfil === "admin") return "";
  dbRequest.input("setor_id", sql.UniqueIdentifier, setorId);
  return ` AND ${alias}.setor_id = @setor_id`;
}

// "Hoje" é o dia civil de Brasília, calculado na aplicação (mesma estratégia do job de
// automação). CAST(GETDATE() AS DATE) dependia do fuso do servidor de banco: num SQL Server
// em UTC, a partir das 21:00 a Central passava a mostrar o dia seguinte.
function hojeBrasilia(): string {
  return agoraEmBrasilia().data;
}
/* Não conformidades registradas nos últimos 30 dias.
 *
 * Substitui os contadores de aprovação e de checklist pendente, que mediam etapas que o
 * fluxo não tem mais. É deliberadamente "registradas", não "abertas": uma não conformidade
 * é um registro na timeline da reserva, sem estado de abertura/fechamento — contar
 * "abertas" seria inventar um conceito que os dados não sustentam.
 */
const SQL_NAO_CONFORMIDADES_RECENTES = `
  SELECT COUNT(*) AS total
  FROM Comentario c
  JOIN Reserva r ON r.id = c.reserva_id
  WHERE c.tipo = 'nao_conformidade'
    AND c.criado_em >= DATEADD(DAY, -30, SYSUTCDATETIME())`;

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // GET /dashboard/kpis (SDD §10/§11): KPIs agregados, escopo por perfil.
  app.get("/api/v1/dashboard/kpis", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const perfil = request.usuario!.perfil as Perfil;
    const setorId = request.usuario!.setorId;

    const plataformasPromise = pool.request().query<{
      total: number;
      disponiveis: number;
      emUso: number;
      manutencao: number;
    }>(
      `WITH PlataformaComStatus AS (
         SELECT ${sqlStatusPlataformaDerivado("p")} AS status FROM Plataforma p
       )
       SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'disponivel' THEN 1 ELSE 0 END) AS disponiveis,
         SUM(CASE WHEN status = 'reservada' THEN 1 ELSE 0 END) AS emUso,
         SUM(CASE WHEN status = 'manutencao' THEN 1 ELSE 0 END) AS manutencao
       FROM PlataformaComStatus`
    );

    const hoje = hojeBrasilia();
    // Só reservas CONFIRMADAS contam como agenda: solicitação pendente não é operação.
    // GLOBAL para todos os perfis: é a ocupação das plataformas ("o que acontece hoje?"),
    // não "o que meu setor reservou" — mesmo critério da Agenda em curso.
    const reservasHojePromise = pool
      .request()
      .input("hoje", sql.Date, hoje)
      .query<{ total: number }>(
        // Reserva de vários dias conta em todo dia que ela atravessa (migration 0029).
        `SELECT COUNT(*) AS total FROM Reserva r
         WHERE r.data <= @hoje AND r.data_fim >= @hoje
           AND r.status IN ('agendada', 'em_uso', 'concluida')`
      );

    const proximos7Promise = pool
      .request()
      .input("hoje", sql.Date, hoje)
      .query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM Reserva r
         WHERE r.data > @hoje AND r.data <= DATEADD(DAY, 7, @hoje)
           AND r.status = 'agendada'`
      );

    // Solicitações aguardando decisão — só para quem decide. Admin e Gestor são aprovadores
    // GLOBAIS, então ambos veem todas. Colaborador recebe null: não há ação a tomar.
    const pendentesPromise =
      perfil === "colaborador"
        ? Promise.resolve(null)
        : pool.request().query<{ total: number; urgentes: number }>(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN r.prioridade = 'urgente' THEN 1 ELSE 0 END) AS urgentes
             FROM Reserva r WHERE r.status = 'pendente'`
          );

    const naoConformidadesRequest = pool.request();
    const whereNcSetor = aplicarEscopoSetor(naoConformidadesRequest, perfil, setorId, "r");
    const naoConformidadesPromise = naoConformidadesRequest.query<{ total: number }>(
      `${SQL_NAO_CONFORMIDADES_RECENTES}${whereNcSetor}`
    );

    const [plataformasResult, reservasHojeResult, proximos7Result, naoConformidadesResult, pendentesResult] =
      await Promise.all([
        plataformasPromise,
        reservasHojePromise,
        proximos7Promise,
        naoConformidadesPromise,
        pendentesPromise,
      ]);

    const row = plataformasResult.recordset[0];
    return reply.status(200).send({
      totalPlataformas: row.total ?? 0,
      disponiveis: row.disponiveis ?? 0,
      emUso: row.emUso ?? 0,
      manutencao: row.manutencao ?? 0,
      reservasHoje: reservasHojeResult.recordset[0]?.total ?? 0,
      reservasProximos7Dias: proximos7Result.recordset[0]?.total ?? 0,
      naoConformidadesRecentes: naoConformidadesResult.recordset[0]?.total ?? 0,
      pendentesAprovacao: pendentesResult ? (pendentesResult.recordset[0]?.total ?? 0) : null,
      pendentesUrgentes: pendentesResult ? (pendentesResult.recordset[0]?.urgentes ?? 0) : null,
    });
  });

  // GET /dashboard/agenda: painéis "Hoje"/"Próximas" (SDD §10), escopo por perfil.
  app.get("/api/v1/dashboard/agenda", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();

    const hoje = hojeBrasilia();
    // Agenda em curso = OPERAÇÃO GLOBAL das plataformas, para qualquer perfil: todos precisam
    // saber se um recurso está ocupado, independentemente do setor. (Antes passava por
    // aplicarEscopoSetor e Gestor/Colaborador só viam o próprio setor.) Mesma projeção de
    // GET /reservas, que já é global. Pendentes ficam fora para não parecerem confirmadas.
    const hojePromise = pool
      .request()
      .input("hoje", sql.Date, hoje)
      .query<ReservaRow>(
        // Agenda em curso: inclui reserva de vários dias que começou antes e ainda cobre hoje.
        `SELECT ${SELECT_RESERVA} ${FROM_RESERVA}
         WHERE r.data <= @hoje AND r.data_fim >= @hoje
           AND r.status IN ('agendada', 'em_uso', 'concluida')
         ORDER BY r.inicio_local ASC`
      );

    // "Minhas próximas reservas" é PESSOAL: filtra pelo solicitante no servidor (antes era o
    // top 8 do setor filtrado depois no navegador, e reservas do próprio usuário podiam ficar
    // de fora do top 8).
    const proximasPromise = pool
      .request()
      .input("hoje", sql.Date, hoje)
      .input("solicitante_id", sql.UniqueIdentifier, request.usuario!.sub)
      .query<ReservaRow>(
        `SELECT TOP 8 ${SELECT_RESERVA} ${FROM_RESERVA}
         WHERE r.solicitante_id = @solicitante_id
           AND r.data > @hoje AND r.data <= DATEADD(DAY, 7, @hoje)
           AND r.status = 'agendada'
         ORDER BY r.data ASC, r.hora_inicio ASC`
      );

    // Solicitações do próprio usuário ainda sem decisão: acompanhadas no painel "Minhas
    // próximas reservas", nunca na timeline operacional.
    const minhasPendentesPromise = pool
      .request()
      .input("hoje", sql.Date, hoje)
      .input("solicitante_id", sql.UniqueIdentifier, request.usuario!.sub)
      .query<ReservaRow>(
        `SELECT TOP 8 ${SELECT_RESERVA} ${FROM_RESERVA}
         WHERE r.solicitante_id = @solicitante_id AND r.status = 'pendente' AND r.data_fim >= @hoje
         ORDER BY r.data ASC, r.hora_inicio ASC`
      );

    const [hojeResult, proximasResult, minhasPendentesResult] = await Promise.all([
      hojePromise,
      proximasPromise,
      minhasPendentesPromise,
    ]);
    return reply.status(200).send({
      hoje: hojeResult.recordset.map(mapReserva),
      proximas: proximasResult.recordset.map(mapReserva),
      minhasPendentes: minhasPendentesResult.recordset.map(mapReserva),
    });
  });

  /* GET /dashboard/checklists-pendentes foi REMOVIDA: o checklist deixou de ser etapa da
     reserva, então "reservas com checklist pendente" não é mais um conceito do domínio. */
}
