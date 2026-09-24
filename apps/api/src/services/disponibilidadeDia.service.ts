import {
  calcularIntervalosLivres,
  combinarDataHoraBrasilia,
  horaParaMinutos,
  inicioDeSlotsLivres,
  MINUTOS_DIA,
  OFFSET_BRASILIA_MINUTOS,
  PASSO_MINUTOS_PADRAO,
  ULTIMO_MINUTO_RESERVAVEL,
  type DisponibilidadeDiaResposta,
  type FaixaMinutos,
  type IntervaloOcupadoDisponibilidade,
  type PlataformaDisponibilidade,
  type Perfil,
  type ProximoHorarioResposta,
  type RegrasAgendaPublicas,
  type StatusPlataforma,
  type StatusReserva,
  type CategoriaPlataforma,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { obterRegrasAgendaPublicas } from "./configuracao.service.js";
import { sqlStatusPlataformaDerivado } from "./plataforma.service.js";

// Disponibilidade AGREGADA. O front antes montava a grade com uma requisição por plataforma
// (reservas + bloqueios de cada uma): N+1 que crescia com a frota. Aqui o dia inteiro sai de
// TRÊS consultas independentes do número de plataformas — plataformas com status derivado,
// reservas do dia e bloqueios que tocam o dia — e a montagem é uma função PURA (sem banco,
// sem relógio, sem sessão), que é o que a torna testável sem infraestrutura.
//
// As regras de conflito continuam sendo as de POST /reservas (services/disponibilidade.service.ts
// é a autoridade, com lock de intervalo): esta leitura é só informativa e nunca reserva nada.

const MS_POR_MINUTO = 60_000;

/** Estados de reserva que APARECEM no dia. `concluida` entra só como histórico do dia e
 *  `pendente` como solicitação aguardando decisão — a timeline a desenha diferenciada, e
 *  nenhuma das duas ocupa horário (ver STATUS_RESERVA_OCUPAM_HORARIO e o cálculo de livres
 *  no frontend). Cancelada/rejeitada nem saem do banco. */
const STATUS_RESERVA_NO_DIA = ["pendente", "agendada", "em_uso", "concluida"] as const;
/** Estados que impedem uma NOVA reserva — o mesmo conjunto de buscarReservasConflitantes
 *  (POST /reservas ignora `concluida`, e o "próximo horário livre" tem de fazer o mesmo). */
const STATUS_RESERVA_OCUPAM_HORARIO = ["agendada", "em_uso"] as const;

// ---------------------------------------------------------------------------------------
// Linhas cruas do banco (entrada da montagem pura)
// ---------------------------------------------------------------------------------------

export interface PlataformaDiaRow {
  id: string;
  codigo: string;
  nome: string;
  categoria: CategoriaPlataforma;
  localizacao: string | null;
  /** Status DERIVADO agora (sqlStatusPlataformaDerivado): disponivel | reservada | manutencao | inativa. */
  status: StatusPlataforma;
  capacidade_operadores: number | null;
}

export interface ReservaDiaRow {
  id: string;
  plataforma_id: string;
  solicitante_id: string;
  status: StatusReserva;
  /** "HH:mm" (CONVERT ... 108). */
  hora_inicio: string;
  hora_fim: string;
  setor_id: string;
  setor_nome: string;
  motivo: string;
  prioridade?: string;
}

export interface BloqueioDiaRow {
  id: string;
  /** null = bloqueio global. */
  plataforma_id: string | null;
  /** Instantes UTC reais (DATETIME2 gravado a partir de combinarDataHoraBrasilia). */
  data_inicio: Date;
  data_fim: Date;
  motivo: string;
}

export interface UsuarioDisponibilidade {
  perfil: Perfil;
  setorId: string | null;
}

// ---------------------------------------------------------------------------------------
// Utilitários de data civil / fuso (puros)
// ---------------------------------------------------------------------------------------

/** "YYYY-MM-DD" que existe no calendário (o regex do schema aceita 2026-02-31). */
export function dataCivilValida(data: string): boolean {
  const [ano, mes, dia] = data.split("-").map(Number);
  if (!ano || ano < 1900 || ano > 2200) return false;
  const teste = new Date(Date.UTC(ano, mes - 1, dia));
  return teste.getUTCFullYear() === ano && teste.getUTCMonth() === mes - 1 && teste.getUTCDate() === dia;
}

export function somarDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

/** Data civil de Brasília no instante `agora` (o servidor pode estar em qualquer fuso). */
export function hojeEmBrasilia(agora: Date): string {
  return new Date(agora.getTime() + OFFSET_BRASILIA_MINUTOS * MS_POR_MINUTO).toISOString().slice(0, 10);
}

/** Minutos (fracionários) do instante `instante` desde 00:00 de Brasília de `data`. */
function minutosDesdeInicioDoDia(instante: Date, data: string): number {
  return (instante.getTime() - combinarDataHoraBrasilia(data, "00:00").getTime()) / MS_POR_MINUTO;
}

/**
 * Primeiro minuto do dia `data` em que uma reserva pode COMEÇAR respeitando a antecedência
 * mínima — o mesmo critério de validarAntecedenciaMinima (início >= agora + antecedência),
 * aplicado ao dia consultado:
 *   0    → dia futuro (a antecedência já está satisfeita desde a meia-noite);
 *   agora + antecedência → hoje (arredondado PARA CIMA: 10:00:30 + 2h só aceita a partir de
 *          10:01, e oferecer 10:00 faria o POST recusar o que a tela sugeriu);
 *   1440 → dia passado (nada mais pode começar).
 * A mesma fórmula cobre as três situações — e também o caso de uma antecedência tão grande
 * que empurra o primeiro horário aceito para dentro de um dia que ainda é "futuro".
 */
export function calcularInicioMinimoMin(data: string, agora: Date, antecedenciaMinimaHoras: number): number {
  const minimo = Math.ceil(minutosDesdeInicioDoDia(agora, data) + antecedenciaMinimaHoras * 60);
  return Math.min(MINUTOS_DIA, Math.max(0, minimo));
}

/**
 * Recorte de um bloqueio (instantes UTC reais) no dia civil de Brasília `data`, em minutos
 * 0..1440. Arredonda PARA FORA (início para baixo, fim para cima): um bloqueio que termina às
 * 12:00:30 nunca pode deixar o minuto 12:00 parecer livre. `null` = não toca o dia.
 */
export function recortarBloqueioNoDia(
  bloqueio: { data_inicio: Date; data_fim: Date },
  data: string
): FaixaMinutos | null {
  const inicioMin = Math.max(0, Math.floor(minutosDesdeInicioDoDia(bloqueio.data_inicio, data)));
  const fimMin = Math.min(MINUTOS_DIA, Math.ceil(minutosDesdeInicioDoDia(bloqueio.data_fim, data)));
  return fimMin > inicioMin ? { inicioMin, fimMin } : null;
}

// ---------------------------------------------------------------------------------------
// Montagem pura de GET /disponibilidade
// ---------------------------------------------------------------------------------------

export interface EntradaMontagemDisponibilidade {
  data: string;
  regras: RegrasAgendaPublicas;
  agora: Date;
  usuario: UsuarioDisponibilidade;
  plataformas: PlataformaDiaRow[];
  reservas: ReservaDiaRow[];
  bloqueios: BloqueioDiaRow[];
}

export function montarDisponibilidadeDia(entrada: EntradaMontagemDisponibilidade): DisponibilidadeDiaResposta {
  const { data, regras, agora, usuario } = entrada;
  const ehAdmin = usuario.perfil === "admin";

  const reservasPorPlataforma = new Map<string, ReservaDiaRow[]>();
  for (const reserva of entrada.reservas) {
    // Defesa em profundidade: a consulta já filtra, mas a função pura não pode depender disso —
    // cancelada/rejeitada não ocupam horário e não podem aparecer na grade.
    if (!(STATUS_RESERVA_NO_DIA as readonly string[]).includes(reserva.status)) continue;
    const lista = reservasPorPlataforma.get(reserva.plataforma_id) ?? [];
    lista.push(reserva);
    reservasPorPlataforma.set(reserva.plataforma_id, lista);
  }

  const plataformas: PlataformaDisponibilidade[] = entrada.plataformas.map((plataforma) => {
    const intervalos: IntervaloOcupadoDisponibilidade[] = [];

    for (const reserva of reservasPorPlataforma.get(plataforma.id) ?? []) {
      // Setor controla a visibilidade do motivo, nunca ownership. O solicitante real segue
      // no contrato para o cliente compará-lo ao id da sessão autenticada.
      const mesmoSetor = usuario.setorId !== null && reserva.setor_id === usuario.setorId;
      intervalos.push({
        inicioMin: horaParaMinutos(reserva.hora_inicio),
        fimMin: horaParaMinutos(reserva.hora_fim),
        tipo: "reserva",
        id: reserva.id,
        status: reserva.status,
        solicitanteId: reserva.solicitante_id,
        prioridade: reserva.prioridade ?? "normal",
        // O setor já é público na mensagem de conflito do POST — mostrá-lo aqui não vaza nada novo.
        setorNome: reserva.setor_nome,
        // O motivo de uma reserva alheia é conteúdo interno do setor dela: só o Admin e o
        // próprio setor o recebem. Mascarado AQUI, no servidor — esconder no front deixaria
        // o texto no payload.
        motivo: ehAdmin || mesmoSetor ? reserva.motivo : null,
      });
    }

    for (const bloqueio of entrada.bloqueios) {
      const global = bloqueio.plataforma_id === null;
      if (!global && bloqueio.plataforma_id !== plataforma.id) continue;
      const faixa = recortarBloqueioNoDia(bloqueio, data);
      if (!faixa) continue;
      intervalos.push({
        ...faixa,
        tipo: global ? "bloqueio_global" : "bloqueio_plataforma",
        id: bloqueio.id,
        // O motivo do bloqueio já é público (vai na mensagem de conflito e em GET /bloqueios).
        motivo: bloqueio.motivo,
      });
    }

    intervalos.sort((a, b) => a.inicioMin - b.inicioMin || a.fimMin - b.fimMin || a.id.localeCompare(b.id));

    return {
      id: plataforma.id,
      codigo: plataforma.codigo,
      nome: plataforma.nome,
      categoria: plataforma.categoria,
      localizacao: plataforma.localizacao,
      status: plataforma.status,
      capacidadeOperadores: plataforma.capacidade_operadores,
      indisponivel: plataforma.status === "manutencao" || plataforma.status === "inativa",
      intervalos,
    };
  });

  return {
    data,
    regras,
    agoraMin:
      hojeEmBrasilia(agora) === data ? Math.floor(minutosDesdeInicioDoDia(agora, data)) : null,
    inicioMinimoMin: calcularInicioMinimoMin(data, agora, regras.antecedenciaMinimaHoras),
    plataformas,
  };
}

// ---------------------------------------------------------------------------------------
// GET /disponibilidade — três consultas
// ---------------------------------------------------------------------------------------

/** Instantes UTC que delimitam os dias civis de Brasília [primeiroDia, ultimoDia] (fim exclusivo). */
function limitesDoIntervalo(primeiroDia: string, ultimoDia: string): { inicio: Date; fim: Date } {
  return {
    inicio: combinarDataHoraBrasilia(primeiroDia, "00:00"),
    fim: combinarDataHoraBrasilia(somarDias(ultimoDia, 1), "00:00"),
  };
}

export async function consultarDisponibilidadeDia(params: {
  data: string;
  plataformaId?: string;
  usuario: UsuarioDisponibilidade;
  agora?: Date;
}): Promise<DisponibilidadeDiaResposta | null> {
  const { data, plataformaId, usuario } = params;
  const pool = await getPool();
  const { inicio, fim } = limitesDoIntervalo(data, data);

  const requestPlataformas = pool.request();
  const requestReservas = pool.request().input("data", sql.Date, data);
  // Os bloqueios são comparados como INSTANTES: o dia civil de Brasília começa 3h depois da
  // meia-noite UTC, então comparar por "data UTC" perderia o fim da noite de Brasília.
  const requestBloqueios = pool.request().input("inicio_dia", sql.DateTime2, inicio).input("fim_dia", sql.DateTime2, fim);

  let filtroPlataforma = "";
  let filtroReservaPlataforma = "";
  let filtroBloqueio = "";
  if (plataformaId) {
    requestPlataformas.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
    requestReservas.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
    requestBloqueios.input("plataforma_id", sql.UniqueIdentifier, plataformaId);
    filtroPlataforma = "WHERE p.id = @plataforma_id";
    filtroReservaPlataforma = "AND r.plataforma_id = @plataforma_id";
    filtroBloqueio = "AND (plataforma_id = @plataforma_id OR plataforma_id IS NULL)";
  }

  const [regras, plataformasResult, reservasResult, bloqueiosResult] = await Promise.all([
    // Cache em memória de ConfiguracaoSistema (invalidado em salvarConfiguracoes) — não é uma
    // consulta a mais por requisição, e é a MESMA fonte que a validação de POST /reservas usa.
    obterRegrasAgendaPublicas(),
    requestPlataformas.query<PlataformaDiaRow>(
      `SELECT p.id, p.codigo, p.nome, p.categoria, p.localizacao, p.capacidade_operadores,
              ${sqlStatusPlataformaDerivado("p")} AS status
       FROM Plataforma p ${filtroPlataforma}
       ORDER BY p.codigo`
    ),
    requestReservas.query<ReservaDiaRow>(
      `SELECT r.id, r.plataforma_id, r.solicitante_id, r.status,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
              r.setor_id, s.nome AS setor_nome, r.motivo, r.prioridade
       FROM Reserva r JOIN Setor s ON s.id = r.setor_id
       WHERE r.data = @data
         AND r.status IN (${STATUS_RESERVA_NO_DIA.map((s) => `'${s}'`).join(", ")})
         ${filtroReservaPlataforma}`
    ),
    requestBloqueios.query<BloqueioDiaRow>(
      `SELECT id, plataforma_id, data_inicio, data_fim, motivo
       FROM BloqueioAgenda
       WHERE data_inicio < @fim_dia AND data_fim > @inicio_dia ${filtroBloqueio}`
    ),
  ]);

  // Filtro por plataforma que não existe: o mesmo 404 de /proximo, em vez de uma grade vazia
  // que pareceria "sem plataformas".
  if (plataformaId && plataformasResult.recordset.length === 0) return null;

  return montarDisponibilidadeDia({
    data,
    regras,
    agora: params.agora ?? new Date(),
    usuario,
    plataformas: plataformasResult.recordset,
    reservas: reservasResult.recordset,
    bloqueios: bloqueiosResult.recordset,
  });
}

// ---------------------------------------------------------------------------------------
// GET /disponibilidade/proximo
// ---------------------------------------------------------------------------------------

export interface ReservaIntervaloRow {
  /** "YYYY-MM-DD" */
  data: string;
  hora_inicio: string;
  hora_fim: string;
}

export interface EntradaProximoHorario {
  data: string;
  duracaoMinutos: number;
  limiteDias: number;
  regras: RegrasAgendaPublicas;
  agora: Date;
  /** manutencao/inativa: a plataforma não pode ser reservada em nenhum horário. */
  plataformaIndisponivel: boolean;
  /** Reservas que OCUPAM horário (pendente/agendada/em_uso) no intervalo varrido. */
  reservas: ReservaIntervaloRow[];
  /** Bloqueios (globais + da plataforma) que tocam o intervalo varrido. */
  bloqueios: Array<{ data_inicio: Date; data_fim: Date }>;
}

const NAO_ENCONTRADO: ProximoHorarioResposta = { encontrado: false, data: null, inicioMin: null, fimMin: null };

/**
 * Primeiro horário livre, a partir de `data`, em que cabe uma reserva de `duracaoMinutos` —
 * varrendo até `limiteDias` dias. Pura: as reservas/bloqueios do intervalo inteiro chegam de
 * UMA consulta cada, então varrer 30 dias não custa 30 idas ao banco.
 *
 * Só oferece o que o POST aceitaria: dentro do expediente (prioridade normal), depois da
 * antecedência mínima, sem passar da duração máxima e sem invadir reserva ou bloqueio.
 */
export function calcularProximoHorario(entrada: EntradaProximoHorario): ProximoHorarioResposta {
  const { data, duracaoMinutos, limiteDias, regras, agora } = entrada;
  if (entrada.plataformaIndisponivel) return NAO_ENCONTRADO;
  // Nenhuma reserva pode passar da duração máxima: pedir mais que isso não tem resposta, e
  // devolver um horário "livre" que o POST recusaria seria pior que dizer que não há.
  if (duracaoMinutos > regras.duracaoMaximaHoras * 60) return NAO_ENCONTRADO;

  const janela: FaixaMinutos = {
    inicioMin: horaParaMinutos(regras.horarioExpedienteInicio),
    // Uma reserva termina, no máximo, às 23:59 (HORA_REGEX) — mesmo com expediente "dia inteiro".
    fimMin: Math.min(horaParaMinutos(regras.horarioExpedienteFim), ULTIMO_MINUTO_RESERVAVEL),
  };

  const reservasPorDia = new Map<string, FaixaMinutos[]>();
  for (const reserva of entrada.reservas) {
    const lista = reservasPorDia.get(reserva.data) ?? [];
    lista.push({ inicioMin: horaParaMinutos(reserva.hora_inicio), fimMin: horaParaMinutos(reserva.hora_fim) });
    reservasPorDia.set(reserva.data, lista);
  }

  for (let deslocamento = 0; deslocamento < limiteDias; deslocamento += 1) {
    const dia = somarDias(data, deslocamento);
    const apartirDeMin = calcularInicioMinimoMin(dia, agora, regras.antecedenciaMinimaHoras);
    if (apartirDeMin >= janela.fimMin) continue;

    const ocupados: FaixaMinutos[] = [...(reservasPorDia.get(dia) ?? [])];
    for (const bloqueio of entrada.bloqueios) {
      const faixa = recortarBloqueioNoDia(bloqueio, dia);
      if (faixa) ocupados.push(faixa);
    }

    const livres = calcularIntervalosLivres(ocupados, janela, apartirDeMin);
    const [primeiroInicio] = inicioDeSlotsLivres(livres, PASSO_MINUTOS_PADRAO, duracaoMinutos);
    if (primeiroInicio !== undefined) {
      return { encontrado: true, data: dia, inicioMin: primeiroInicio, fimMin: primeiroInicio + duracaoMinutos };
    }
  }
  return NAO_ENCONTRADO;
}

/** `null` = a plataforma não existe (a rota responde 404). */
export async function buscarProximoHorario(params: {
  plataformaId: string;
  data: string;
  duracaoMinutos: number;
  limiteDias: number;
  agora?: Date;
}): Promise<ProximoHorarioResposta | null> {
  const { plataformaId, data, duracaoMinutos, limiteDias } = params;
  const pool = await getPool();
  const ultimoDia = somarDias(data, limiteDias - 1);
  const { inicio, fim } = limitesDoIntervalo(data, ultimoDia);

  const [regras, plataformaResult, reservasResult, bloqueiosResult] = await Promise.all([
    obterRegrasAgendaPublicas(),
    // Status CRU (não derivado): "reservada agora" não torna a plataforma indisponível para
    // amanhã — só manutenção/inativa a tiram de circulação por completo.
    pool
      .request()
      .input("id", sql.UniqueIdentifier, plataformaId)
      .query<{ status: string }>("SELECT status FROM Plataforma WHERE id = @id"),
    pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .input("de", sql.Date, data)
      .input("ate", sql.Date, ultimoDia)
      .query<ReservaIntervaloRow>(
        `SELECT CONVERT(varchar(10), r.data, 23) AS data,
                CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
                CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim
         FROM Reserva r
         WHERE r.plataforma_id = @plataforma_id AND r.data >= @de AND r.data <= @ate
           AND r.status IN (${STATUS_RESERVA_OCUPAM_HORARIO.map((s) => `'${s}'`).join(", ")})`
      ),
    pool
      .request()
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .input("inicio", sql.DateTime2, inicio)
      .input("fim", sql.DateTime2, fim)
      .query<{ data_inicio: Date; data_fim: Date }>(
        `SELECT data_inicio, data_fim FROM BloqueioAgenda
         WHERE (plataforma_id = @plataforma_id OR plataforma_id IS NULL)
           AND data_inicio < @fim AND data_fim > @inicio`
      ),
  ]);

  const plataforma = plataformaResult.recordset[0];
  if (!plataforma) return null;

  return calcularProximoHorario({
    data,
    duracaoMinutos,
    limiteDias,
    regras,
    agora: params.agora ?? new Date(),
    plataformaIndisponivel: plataforma.status === "manutencao" || plataforma.status === "inativa",
    reservas: reservasResult.recordset,
    bloqueios: bloqueiosResult.recordset,
  });
}
