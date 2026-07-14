import type { FastifyInstance } from "fastify";
import { getPool, sql } from "../db/pool.js";
import { autenticar } from "../middlewares/rbac.js";
import { sqlStatusPlataformaDerivado } from "../services/plataforma.service.js";
import { SELECT_RESERVA, FROM_RESERVA, mapReserva, type ReservaRow } from "./reservas.js";

type Perfil = "admin" | "gestor_setor" | "colaborador";

// Escopo padrão do módulo Dashboard (SDD §10): Admin vê o agregado global; Gestor de
// Setor e Colaborador só veem dados do próprio setor — mesmo critério já usado em
// /historico e /relatorios (resolverEscopoSetor).
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

// Mesmo critério de "Pendências de Aprovação" usado desde S7: Admin vê todas as
// pendentes; Gestor de Setor só as do próprio setor que ainda aguardam sua própria
// decisão; Colaborador não aprova (0).
async function contarPendenciasAprovacao(
  pool: Awaited<ReturnType<typeof getPool>>,
  perfil: Perfil,
  setorId: string | null
): Promise<number> {
  if (perfil === "admin") {
    const result = await pool.request().query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM Reserva WHERE status = 'pendente'"
    );
    return result.recordset[0]?.total ?? 0;
  }
  if (perfil === "gestor_setor") {
    const result = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM Reserva
         WHERE status = 'pendente' AND setor_id = @setor_id AND aprovado_por_id IS NULL`
      );
    return result.recordset[0]?.total ?? 0;
  }
  return 0;
}

// RN-RES-12/RF-RES-10 (requerChecklist): categoria elevatória/andaime exige checklist
// preenchido antes do início de uso. "Pendente" aqui = reserva já agendada cuja
// plataforma exige checklist e que ainda não tem nenhum ChecklistPreenchido — é
// exatamente o que bloqueia "Iniciar Uso" (ver checklist.ts), então serve como atalho
// acionável de verdade, não um número decorativo.
const WHERE_CHECKLIST_PENDENTE = `
  WHERE r.status = 'agendada' AND p.categoria IN ('elevatoria', 'andaime')
    AND NOT EXISTS (SELECT 1 FROM ChecklistPreenchido cp WHERE cp.reserva_id = r.id)`;

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

    const reservasHojeRequest = pool.request();
    const whereHojeSetor = aplicarEscopoSetor(reservasHojeRequest, perfil, setorId, "r");
    const reservasHojePromise = reservasHojeRequest.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Reserva r
       WHERE r.data = CAST(GETDATE() AS DATE)
         AND r.status IN ('pendente', 'agendada', 'em_uso', 'concluida')${whereHojeSetor}`
    );

    const proximos7Request = pool.request();
    const whereProximosSetor = aplicarEscopoSetor(proximos7Request, perfil, setorId, "r");
    const proximos7Promise = proximos7Request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Reserva r
       WHERE r.data > CAST(GETDATE() AS DATE) AND r.data <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE))
         AND r.status IN ('pendente', 'agendada')${whereProximosSetor}`
    );

    const checklistRequest = pool.request();
    const whereChecklistSetor = aplicarEscopoSetor(checklistRequest, perfil, setorId, "r");
    const checklistPromise = checklistRequest.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Reserva r JOIN Plataforma p ON p.id = r.plataforma_id
       ${WHERE_CHECKLIST_PENDENTE}${whereChecklistSetor}`
    );

    const [plataformasResult, pendenciasAprovacao, reservasHojeResult, proximos7Result, checklistResult] =
      await Promise.all([
        plataformasPromise,
        contarPendenciasAprovacao(pool, perfil, setorId),
        reservasHojePromise,
        proximos7Promise,
        checklistPromise,
      ]);

    const row = plataformasResult.recordset[0];
    return reply.status(200).send({
      totalPlataformas: row.total ?? 0,
      disponiveis: row.disponiveis ?? 0,
      emUso: row.emUso ?? 0,
      manutencao: row.manutencao ?? 0,
      reservasHoje: reservasHojeResult.recordset[0]?.total ?? 0,
      reservasProximos7Dias: proximos7Result.recordset[0]?.total ?? 0,
      pendenciasAprovacao,
      checklistsPendentes: checklistResult.recordset[0]?.total ?? 0,
    });
  });

  // GET /dashboard/agenda: painéis "Hoje"/"Próximas" (SDD §10), escopo por perfil.
  app.get("/api/v1/dashboard/agenda", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const perfil = request.usuario!.perfil as Perfil;
    const setorId = request.usuario!.setorId;

    const hojeRequest = pool.request();
    const whereHojeSetor = aplicarEscopoSetor(hojeRequest, perfil, setorId, "r");
    const hojePromise = hojeRequest.query<ReservaRow>(
      `SELECT ${SELECT_RESERVA} ${FROM_RESERVA}
       WHERE r.data = CAST(GETDATE() AS DATE)
         AND r.status IN ('pendente', 'agendada', 'em_uso', 'concluida')${whereHojeSetor}
       ORDER BY r.hora_inicio ASC`
    );

    const proximasRequest = pool.request();
    const whereProximasSetor = aplicarEscopoSetor(proximasRequest, perfil, setorId, "r");
    const proximasPromise = proximasRequest.query<ReservaRow>(
      `SELECT TOP 8 ${SELECT_RESERVA} ${FROM_RESERVA}
       WHERE r.data > CAST(GETDATE() AS DATE) AND r.data <= DATEADD(DAY, 7, CAST(GETDATE() AS DATE))
         AND r.status IN ('pendente', 'agendada')${whereProximasSetor}
       ORDER BY r.data ASC, r.hora_inicio ASC`
    );

    const [hojeResult, proximasResult] = await Promise.all([hojePromise, proximasPromise]);
    return reply.status(200).send({
      hoje: hojeResult.recordset.map(mapReserva),
      proximas: proximasResult.recordset.map(mapReserva),
    });
  });

  // GET /dashboard/checklists-pendentes: atalho para checklist pendente (SDD §10).
  app.get("/api/v1/dashboard/checklists-pendentes", { preHandler: autenticar }, async (request, reply) => {
    const pool = await getPool();
    const perfil = request.usuario!.perfil as Perfil;
    const setorId = request.usuario!.setorId;

    const dbRequest = pool.request();
    const whereSetor = aplicarEscopoSetor(dbRequest, perfil, setorId, "r");
    const result = await dbRequest.query<ReservaRow>(
      `SELECT TOP 6 ${SELECT_RESERVA} ${FROM_RESERVA}
       ${WHERE_CHECKLIST_PENDENTE}${whereSetor}
       ORDER BY r.data ASC, r.hora_inicio ASC`
    );
    return reply.status(200).send(result.recordset.map(mapReserva));
  });
}
