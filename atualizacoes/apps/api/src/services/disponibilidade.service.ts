import {
  combinarDataHoraBrasilia,
  formatarHorarioReserva,
  periodosSeSobrepoem,
  STATUS_RESERVA_OCUPAM_PLATAFORMA,
  type ConflitoAprovacao,
  type PeriodoReserva,
} from "@plataformares/shared";
import { sql } from "../db/pool.js";
import {
  encontrarBloqueioConflitante,
  encontrarConflito,
  type BloqueioAtivo,
  type ReservaExistente,
} from "./conflito.service.js";

const SQL_STATUS_OCUPAM = STATUS_RESERVA_OCUPAM_PLATAFORMA.map((s) => `'${s}'`).join(", ");

// Fonte única de verdade para "esta plataforma está disponível neste horário?" — usada
// pela criação de reserva (única e recorrente, dentro de transação) e pela checagem em
// tempo real do formulário (GET /reservas/conflitos, fora de transação). Reúne as duas
// checagens de disponibilidade do sistema:
//   - RN-RES-02: conflito com outra reserva já existente da mesma plataforma;
//   - RN-RES-11/RN-BLK-01: bloqueio de agenda ativo (global ou da própria plataforma).
// Qualquer novo ponto de entrada que precise validar disponibilidade (edição/reagendamento
// de reserva, por exemplo) deve reaproveitar `verificarDisponibilidade` em vez de duplicar
// esta lógica — `ignorarReservaId` já existe em toda a cadeia para excluir a própria
// reserva ao validar uma edição.

interface ReservaConflitoRow {
  id: string;
  data: string;
  data_fim: string;
  hora_inicio: string;
  hora_fim: string;
  setor_nome: string;
}

/* Período completo como parâmetros SQL de data civil: candidatas são as reservas cujo
   intervalo de DIAS toca o da nova (data <= dataFim nova AND data_fim >= data nova); a
   sobreposição exata de data+hora é decidida em seguida (periodosSeSobrepoem). Filtrar pelas
   colunas de dia mantém a busca no índice (plataforma_id, data) — o mesmo do lock. */
function filtroDiasDoPeriodo(
  dbRequest: sql.Request,
  periodo: Pick<PeriodoReserva, "data" | "dataFim">,
  alias = "r"
): string {
  dbRequest.input("periodo_data", sql.Date, periodo.data).input("periodo_data_fim", sql.Date, periodo.dataFim);
  return `${alias}.data <= @periodo_data_fim AND ${alias}.data_fim >= @periodo_data`;
}

export const SELECT_PERIODO_RESERVA = `CONVERT(varchar(10), r.data, 23) AS data, CONVERT(varchar(10), r.data_fim, 23) AS data_fim,
            CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio, CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim`;

export function periodoDaLinha(r: { data: string; data_fim: string; hora_inicio: string; hora_fim: string }): PeriodoReserva {
  return { data: r.data, dataFim: r.data_fim, horaInicio: r.hora_inicio, horaFim: r.hora_fim };
}

// Pool e Transaction expõem a mesma fábrica de Request — tipar por essa capacidade
// permite rodar a checagem de disponibilidade tanto fora (leitura rápida do formulário)
// quanto dentro de uma transação (criação, onde ela precisa ser atômica).
export type ExecutorSql = { request(): sql.Request };

export async function buscarReservasConflitantes(
  executor: ExecutorSql,
  plataformaId: string,
  periodo: Pick<PeriodoReserva, "data" | "dataFim">,
  ignorarReservaId?: string,
  bloquearIntervalo = false
): Promise<ReservaConflitoRow[]> {
  const dbRequest = executor.request().input("plataforma_id", sql.UniqueIdentifier, plataformaId);

  // Só reservas CONFIRMADAS ocupam a plataforma (migration 0022): uma solicitação pendente
  // não bloqueia o horário indefinidamente — a disponibilidade é revalidada na aprovação.
  let where = `r.plataforma_id = @plataforma_id AND ${filtroDiasDoPeriodo(dbRequest, periodo)} AND r.status IN (${SQL_STATUS_OCUPAM})`;
  if (ignorarReservaId) {
    dbRequest.input("ignorar_id", sql.UniqueIdentifier, ignorarReservaId);
    where += " AND r.id <> @ignorar_id";
  }

  // RN-RES-02 sob concorrência: UPDLOCK+HOLDLOCK toma um key-range lock no índice
  // (plataforma_id, data) — até a data final do período — até o fim da transação: uma segunda
  // requisição simultânea para a mesma plataforma em dias que se cruzam espera a primeira
  // concluir em vez de ler o estado antigo e inserir uma reserva sobreposta. Reservas de
  // outras plataformas não são afetadas.
  const hints = bloquearIntervalo ? " WITH (UPDLOCK, HOLDLOCK)" : "";

  const result = await dbRequest.query<ReservaConflitoRow>(
    `SELECT r.id, ${SELECT_PERIODO_RESERVA}, s.nome AS setor_nome
     FROM Reserva r${hints} JOIN Setor s ON s.id = r.setor_id
     WHERE ${where}`
  );
  return result.recordset;
}

interface BloqueioAtivoRow {
  id: string;
  plataforma_id: string | null;
  data_inicio: Date;
  data_fim: Date;
  motivo: string;
}

// S9 (RN-RES-11): bloqueios (globais ou da própria plataforma) que tocam os dias do período
// da reserva. A sobreposição exata contra o horário é decidida em conflito.service.ts.
export async function buscarBloqueiosAtivos(
  executor: ExecutorSql,
  plataformaId: string,
  periodo: Pick<PeriodoReserva, "data" | "dataFim">
): Promise<BloqueioAtivoRow[]> {
  // BloqueioAgenda guarda INSTANTES UTC reais, e o dia da reserva é um dia civil de Brasília
  // (UTC-3): ele vai de `data` 03:00Z até `data+1` 03:00Z. Comparar contra a meia-noite UTC
  // (CAST(@data AS DATETIME2)) deixava de fora um bloqueio que cobre só a noite de Brasília
  // (ex.: 21:00–23:59 = 00:00Z–03:00Z do dia seguinte), e o POST aceitava uma reserva em cima
  // dele — enquanto GET /disponibilidade, que usa estes mesmos limites, já o mostrava ocupado.
  const inicioDia = combinarDataHoraBrasilia(periodo.data, "00:00");
  const fimDia = new Date(combinarDataHoraBrasilia(periodo.dataFim, "00:00").getTime() + 24 * 60 * 60_000);
  const result = await executor
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("inicio_dia", sql.DateTime2, inicioDia)
    .input("fim_dia", sql.DateTime2, fimDia)
    .query<BloqueioAtivoRow>(
      `SELECT id, plataforma_id, data_inicio, data_fim, motivo FROM BloqueioAgenda
       WHERE (plataforma_id = @plataforma_id OR plataforma_id IS NULL)
         AND data_inicio < @fim_dia
         AND data_fim > @inicio_dia`
    );
  return result.recordset;
}

function mapBloqueioAtivo(row: BloqueioAtivoRow): BloqueioAtivo {
  return { id: row.id, plataformaId: row.plataforma_id, dataInicio: row.data_inicio, dataFim: row.data_fim, motivo: row.motivo };
}

function formatarDataHora(data: Date): string {
  return data.toISOString().slice(0, 16).replace("T", " ");
}

export interface DisponibilidadeResultado {
  ok: boolean;
  erro?: string;
  // Tipo estruturado do conflito, para o frontend diferenciar a mensagem (PARTE 4/6 —
  // continua enviando `erro` como texto pronto, já no padrão de resposta existente da API;
  // estes campos só enriquecem, sem trocar o formato).
  tipo?: "conflito_reserva" | "bloqueio_global" | "bloqueio_plataforma";
  reservaConflitante?: { id: string; setorNome: string; data: string; dataFim: string; horaInicio: string; horaFim: string };
  bloqueio?: { inicio: string; fim: string; motivo: string };
}

export async function verificarDisponibilidade(
  dados: PeriodoReserva & {
    plataformaId: string;
    ignorarReservaId?: string;
  },
  executor: ExecutorSql,
  bloquearIntervalo = false
): Promise<DisponibilidadeResultado> {
  const conflitantes = await buscarReservasConflitantes(
    executor,
    dados.plataformaId,
    dados,
    dados.ignorarReservaId,
    bloquearIntervalo
  );
  const conflito = encontrarConflito(
    conflitantes.map<ReservaExistente>((r) => ({ id: r.id, ...periodoDaLinha(r) })),
    dados
  );
  if (conflito) {
    const detalhe = conflitantes.find((r) => r.id === conflito.id)!;
    const periodo = periodoDaLinha(detalhe);
    // Mesmo dia da nova: só o horário; outro dia (vários dias): com a data de início.
    const quando =
      periodo.data === dados.data && periodo.dataFim === dados.data
        ? formatarHorarioReserva(periodo)
        : `${periodo.data.split("-").reverse().join("/")} ${formatarHorarioReserva(periodo)}`;
    return {
      ok: false,
      erro: `Conflito de horário com reserva do setor ${detalhe.setor_nome} (${quando}).`,
      tipo: "conflito_reserva",
      reservaConflitante: {
        id: detalhe.id,
        setorNome: detalhe.setor_nome,
        ...periodo,
      },
    };
  }

  return verificarBloqueio(dados, executor);
}

/**
 * Só a parte de BLOQUEIO DE AGENDA de verificarDisponibilidade. Usada à parte pela criação de
 * reserva URGENTE: ela pode ser solicitada sobre outra reserva (vira pendente para decisão),
 * mas bloqueio é indisponibilidade técnica e continua barrando — urgência não é bypass.
 */
export async function verificarBloqueio(
  dados: PeriodoReserva & { plataformaId: string },
  executor: ExecutorSql
): Promise<DisponibilidadeResultado> {
  const bloqueiosAtivos = await buscarBloqueiosAtivos(executor, dados.plataformaId, dados);
  const bloqueio = encontrarBloqueioConflitante(bloqueiosAtivos.map(mapBloqueioAtivo), dados.plataformaId, dados);
  if (bloqueio) {
    return {
      ok: false,
      erro: `Reserva bloqueada pela agenda: ${bloqueio.motivo} (bloqueio de ${formatarDataHora(bloqueio.dataInicio)} a ${formatarDataHora(bloqueio.dataFim)}).`,
      tipo: bloqueio.plataformaId === null ? "bloqueio_global" : "bloqueio_plataforma",
      bloqueio: {
        inicio: formatarDataHora(bloqueio.dataInicio),
        fim: formatarDataHora(bloqueio.dataFim),
        motivo: bloqueio.motivo,
      },
    };
  }

  return { ok: true };
}

export interface ConflitoAprovacaoInterno extends ConflitoAprovacao {
  solicitanteId: string;
}

export interface AnaliseAprovacao {
  conflitos: ConflitoAprovacaoInterno[];
  bloqueio: { inicio: string; fim: string; motivo: string; global: boolean } | null;
}

/**
 * Revalidação da aprovação: TODAS as reservas confirmadas (agendada/em_uso) que se
 * sobrepõem à solicitação, com os dados que o aprovador precisa ver antes de decidir uma
 * substituição, mais o bloqueio de agenda que cubra o horário. Mesma regra de sobreposição
 * (RN-RES-02) e o MESMO lock de intervalo da criação — chamada dentro da transação da
 * aprovação, serializa aprovações concorrentes da mesma plataforma/dia: a segunda enxerga a
 * primeira já agendada e recebe conflito, nunca uma sobreposição.
 *
 * Bloqueio de agenda é devolvido à parte porque NÃO é substituível: indisponibilidade
 * técnica não é "outra reserva".
 */
export async function analisarAprovacao(
  executor: ExecutorSql,
  dados: PeriodoReserva & { reservaId: string; plataformaId: string },
  // false = pré-visualização (GET), sem segurar lock; a decisão (POST) sempre trava.
  bloquearIntervalo = true
): Promise<AnaliseAprovacao> {
  const consulta = executor
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, dados.plataformaId)
    .input("ignorar_id", sql.UniqueIdentifier, dados.reservaId);
  const filtroDias = filtroDiasDoPeriodo(consulta, dados);
  const resultado = await consulta
    .query<{
      id: string;
      data: string;
      data_fim: string;
      hora_inicio: string;
      hora_fim: string;
      setor_id: string;
      setor_nome: string;
      solicitante_id: string;
      solicitante_nome: string;
      plataforma_nome: string;
      prioridade: string;
      status: string;
    }>(
      `SELECT r.id, ${SELECT_PERIODO_RESERVA},
              r.setor_id, s.nome AS setor_nome, r.solicitante_id, u.nome AS solicitante_nome,
              p.nome AS plataforma_nome, r.prioridade, r.status
       FROM Reserva r${bloquearIntervalo ? " WITH (UPDLOCK, HOLDLOCK)" : ""}
       JOIN Setor s ON s.id = r.setor_id
       JOIN Usuario u ON u.id = r.solicitante_id
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.plataforma_id = @plataforma_id AND ${filtroDias}
         AND r.status IN (${SQL_STATUS_OCUPAM}) AND r.id <> @ignorar_id
       ORDER BY r.data, r.hora_inicio`
    );

  const conflitos = resultado.recordset
    .filter((r) => periodosSeSobrepoem(dados, periodoDaLinha(r)))
    .map<ConflitoAprovacaoInterno>((r) => ({
      id: r.id,
      plataformaNome: r.plataforma_nome,
      solicitanteId: r.solicitante_id,
      solicitanteNome: r.solicitante_nome,
      setorId: r.setor_id,
      setorNome: r.setor_nome,
      data: r.data,
      dataFim: r.data_fim,
      horaInicio: r.hora_inicio,
      horaFim: r.hora_fim,
      prioridade: r.prioridade,
      status: r.status,
    }));

  const bloqueiosAtivos = await buscarBloqueiosAtivos(executor, dados.plataformaId, dados);
  const bloqueio = encontrarBloqueioConflitante(bloqueiosAtivos.map(mapBloqueioAtivo), dados.plataformaId, dados);

  return {
    conflitos,
    bloqueio: bloqueio
      ? {
          inicio: formatarDataHora(bloqueio.dataInicio),
          fim: formatarDataHora(bloqueio.dataFim),
          motivo: bloqueio.motivo,
          global: bloqueio.plataformaId === null,
        }
      : null,
  };
}

// SQL Server escolhe uma "vítima" (erro 1205) quando duas transações esperam uma pela outra. O
// key-range lock acima (UPDLOCK+HOLDLOCK em plataforma+dia) é correto, mas com TRÊS ou mais
// requisições simultâneas para o mesmo dia ele pode entrar em ciclo: uma que já aguardava a
// chave seguinte e outra que chegou depois e travou a chave recém-inserida, em ordens opostas.
// O próprio servidor manda "rerodar a transação" — sem isso a vítima virava um 500, quando o
// resultado correto é o mesmo de qualquer perdedora da corrida: 409 (ou 201, se ela vencer).
const CODIGO_SQL_DEADLOCK = 1205;

export function ehDeadlockSql(erro: unknown): boolean {
  const candidato = erro as { number?: number; originalError?: { info?: { number?: number } } } | null;
  return (
    candidato?.number === CODIGO_SQL_DEADLOCK || candidato?.originalError?.info?.number === CODIGO_SQL_DEADLOCK
  );
}

/**
 * Reexecuta `operacao` (que abre e fecha a PRÓPRIA transação) quando ela é escolhida como
 * vítima de deadlock — no máximo `maxTentativas` execuções no total. Qualquer outro erro, ou o
 * deadlock persistente depois da última tentativa, é propagado sem alteração. Não muda o
 * modelo de lock: só devolve a decisão de "quem venceu" ao mesmo caminho de sempre.
 */
export async function executarComRepeticaoEmDeadlock<T>(
  operacao: () => Promise<T>,
  maxTentativas = 4,
  esperar: (ms: number) => Promise<void> = (ms) => new Promise((resolver) => setTimeout(resolver, ms))
): Promise<T> {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      return await operacao();
    } catch (erro) {
      if (!ehDeadlockSql(erro) || tentativa >= maxTentativas) throw erro;
      // Espera curta e aleatória: reexecutar em uníssono reproduziria o mesmo ciclo.
      await esperar(10 + Math.floor(Math.random() * 40) * tentativa);
    }
  }
}
