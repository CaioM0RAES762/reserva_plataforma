import { OFFSET_BRASILIA_MINUTOS } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import { concluirReserva, iniciarUsoReserva } from "./reservaTransicao.service.js";

// Relógio civil de Brasília a partir de um instante UTC — inverso exato de
// `combinarDataHoraBrasilia` (packages/shared/datetime.ts), a estratégia de fuso que o
// projeto já usa. Reserva.data (DATE) e hora_inicio/hora_fim (TIME) guardam horário civil
// de Brasília, então a comparação precisa ser feita nesse mesmo referencial.
//
// Deliberadamente NÃO se usa GETDATE()/SYSDATETIME() do SQL Server para essa comparação: o
// resultado dependeria do fuso configurado no servidor de banco, e a mesma consulta passaria
// a se comportar diferente em produção e em desenvolvimento.
export function agoraEmBrasilia(agora: Date = new Date()): { data: string; hora: string } {
  const deslocado = new Date(agora.getTime() + OFFSET_BRASILIA_MINUTOS * 60_000);
  const data = deslocado.toISOString().slice(0, 10);
  const hora = deslocado.toISOString().slice(11, 16);
  return { data, hora };
}

/* "Agora" de Brasília como DATETIME2 do SQL, no mesmo referencial de Reserva.inicio_local/
   fim_local (migration 0029). Enviado como texto ISO e convertido no banco: nenhum ajuste de
   fuso do driver entra no caminho. */
const SQL_AGORA = "CAST(@agora AS DATETIME2(0))";

function agoraLocalIso(data: string, hora: string): string {
  return `${data}T${hora}:00`;
}

export interface ResumoAutomacao {
  iniciadas: string[];
  concluidas: string[];
  /** Janelas inteiras vencidas sem uso, encerradas direto de 'agendada' para 'concluida'. */
  encerradasSemUso: string[];
  ignoradas: number;
}

interface CandidataRow {
  id: string;
  plataforma_id: string;
  plataforma_status: string;
}

// Início automático — o comportamento PADRÃO do fluxo. Só entram reservas cuja janela está
// ACONTECENDO agora (início <= agora < fim — período completo, inclusive de vários dias). O recorte importa:
// varrer o passado aqui colocaria "em uso" reservas de dias anteriores que já venceram —
// esse caso é tratado por `candidatasAEncerramentoSemUso`, que as leva direto a concluída.
async function candidatasAoInicio(data: string, hora: string): Promise<CandidataRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agora", sql.VarChar, agoraLocalIso(data, hora))
    .query<CandidataRow>(
      `SELECT r.id, r.plataforma_id, p.status AS plataforma_status
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.status = 'agendada'
         AND r.inicio_automatico = 1
         AND r.inicio_local <= ${SQL_AGORA}
         AND r.fim_local > ${SQL_AGORA}`
    );
  return result.recordset;
}

// RF — finalização automática. Aqui o passado É considerado: uma reserva que ficou "em uso"
// e cujo horário final já passou deve ser encerrada mesmo que o worker estivesse fora do ar
// no momento exato — deixar plataforma ocupada indefinidamente bloquearia novas reservas.
async function candidatasAConclusao(data: string, hora: string): Promise<CandidataRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agora", sql.VarChar, agoraLocalIso(data, hora))
    .query<CandidataRow>(
      // Fim COMPLETO (data_fim + hora_fim): uma reserva de vários dias não é encerrada na
      // primeira meia-noite.
      `SELECT r.id, r.plataforma_id, p.status AS plataforma_status
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.status = 'em_uso'
         AND r.fim_automatico = 1
         AND r.fim_local <= ${SQL_AGORA}`
    );
  return result.recordset;
}

/* Recuperação de janela perdida.
 *
 * Cenário real: reserva das 08:00 às 10:00, o servidor fica fora do ar a manhã inteira e
 * volta às 11:00 com a reserva ainda 'agendada'. Passar por 'em_uso' agora seria falso —
 * o uso não está acontecendo. Ficar 'agendada' para sempre é pior ainda: a plataforma
 * aparece comprometida numa janela que já passou e a lista nunca se resolve sozinha.
 *
 * A janela terminou, então a reserva vai direto para 'concluida'. É o mesmo raciocínio do
 * encerramento automático, aplicado a uma reserva que nunca chegou a iniciar. */
async function candidatasAEncerramentoSemUso(data: string, hora: string): Promise<CandidataRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("agora", sql.VarChar, agoraLocalIso(data, hora))
    .query<CandidataRow>(
      `SELECT r.id, r.plataforma_id, p.status AS plataforma_status
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.status = 'agendada'
         AND r.fim_automatico = 1
         AND r.fim_local <= ${SQL_AGORA}`
    );
  return result.recordset;
}

// Executado periodicamente pelo worker BullMQ (ver services/queue.ts). Toda a segurança
// contra execução dupla está em reservaTransicao.service.ts: a transição é um UPDATE
// condicional pelo status de partida, então rodar esta função duas vezes em paralelo — ou
// junto com um clique manual — produz no máximo uma transição por reserva.
//
// Nenhum e-mail é disparado aqui. Início e conclusão de uso nunca notificaram por e-mail
// (só aprovação/rejeição o fazem), e a automação não introduz esse efeito: um job periódico
// somado a envio de e-mail é exatamente a receita de tempestade de notificações.
export async function processarAutomacaoReservas(
  agora: Date = new Date(),
  // Restringe a execução a estas reservas (testes com relógio simulado): sem isto, um "agora"
  // no futuro moveria também reservas reais do banco. O worker nunca passa este filtro.
  opcoes: { somenteIds?: string[] } = {}
): Promise<ResumoAutomacao> {
  const { data, hora } = agoraEmBrasilia(agora);
  const resumo: ResumoAutomacao = { iniciadas: [], concluidas: [], encerradasSemUso: [], ignoradas: 0 };
  const permitidas = opcoes.somenteIds ? new Set(opcoes.somenteIds.map((id) => id.toLowerCase())) : null;
  const filtrar = (lista: CandidataRow[]) => (permitidas ? lista.filter((c) => permitidas.has(c.id.toLowerCase())) : lista);

  for (const candidata of filtrar(await candidatasAoInicio(data, hora))) {
    const resultado = await iniciarUsoReserva({
      reservaId: candidata.id,
      origem: "automatica",
      usuarioId: null,
      contexto: { plataformaId: candidata.plataforma_id, plataformaStatus: candidata.plataforma_status },
    });
    if (resultado.aplicada) resumo.iniciadas.push(candidata.id);
    else resumo.ignoradas += 1;
  }

  for (const candidata of filtrar(await candidatasAConclusao(data, hora))) {
    const resultado = await concluirReserva({
      reservaId: candidata.id,
      origem: "automatica",
      usuarioId: null,
    });
    if (resultado.aplicada) resumo.concluidas.push(candidata.id);
    else resumo.ignoradas += 1;
  }

  // Por último, de propósito: as duas varreduras acima já moveram tudo o que ainda estava
  // dentro de uma janela válida. O que sobrar em 'agendada' com o horário final no passado
  // é genuinamente uma janela perdida.
  for (const candidata of filtrar(await candidatasAEncerramentoSemUso(data, hora))) {
    const resultado = await concluirReserva({
      reservaId: candidata.id,
      origem: "automatica",
      usuarioId: null,
      // A reserva nunca entrou em uso: a transição parte de 'agendada', não de 'em_uso'.
      statusDeEsperado: "agendada",
    });
    if (resultado.aplicada) resumo.encerradasSemUso.push(candidata.id);
    else resumo.ignoradas += 1;
  }

  return resumo;
}
