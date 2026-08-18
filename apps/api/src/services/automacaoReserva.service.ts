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

export interface ResumoAutomacao {
  iniciadas: string[];
  concluidas: string[];
  ignoradas: number;
}

interface CandidataRow {
  id: string;
  plataforma_id: string;
  plataforma_status: string;
}

// RF — início automático. Só entram reservas cuja janela está ACONTECENDO agora
// (hora_inicio <= agora < hora_fim, no mesmo dia): sem esse recorte, a primeira execução do
// worker após o recurso ser habilitado varreria o passado inteiro e colocaria em uso
// reservas de dias anteriores que nunca foram iniciadas. Reserva vencida sem uso permanece
// "agendada" para tratamento humano, que é a informação correta.
async function candidatasAoInicio(data: string, hora: string): Promise<CandidataRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("data", sql.Date, data)
    .input("hora", sql.VarChar, hora)
    .query<CandidataRow>(
      `SELECT r.id, r.plataforma_id, p.status AS plataforma_status
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.status = 'agendada'
         AND r.inicio_automatico = 1
         AND r.data = @data
         AND r.hora_inicio <= @hora
         AND r.hora_fim > @hora`
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
    .input("data", sql.Date, data)
    .input("hora", sql.VarChar, hora)
    .query<CandidataRow>(
      `SELECT r.id, r.plataforma_id, p.status AS plataforma_status
       FROM Reserva r
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.status = 'em_uso'
         AND r.fim_automatico = 1
         AND (r.data < @data OR (r.data = @data AND r.hora_fim <= @hora))`
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
export async function processarAutomacaoReservas(agora: Date = new Date()): Promise<ResumoAutomacao> {
  const { data, hora } = agoraEmBrasilia(agora);
  const resumo: ResumoAutomacao = { iniciadas: [], concluidas: [], ignoradas: 0 };

  for (const candidata of await candidatasAoInicio(data, hora)) {
    const resultado = await iniciarUsoReserva({
      reservaId: candidata.id,
      origem: "automatica",
      usuarioId: null,
      contexto: { plataformaId: candidata.plataforma_id, plataformaStatus: candidata.plataforma_status },
    });
    if (resultado.aplicada) resumo.iniciadas.push(candidata.id);
    else resumo.ignoradas += 1;
  }

  for (const candidata of await candidatasAConclusao(data, hora)) {
    const resultado = await concluirReserva({
      reservaId: candidata.id,
      origem: "automatica",
      usuarioId: null,
    });
    if (resultado.aplicada) resumo.concluidas.push(candidata.id);
    else resumo.ignoradas += 1;
  }

  return resumo;
}
