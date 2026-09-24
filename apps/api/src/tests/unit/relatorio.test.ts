import { describe, expect, it } from "vitest";
import { combinarDataHoraBrasilia, STATUS_RESERVA } from "@plataformares/shared";
import {
  calcularChecklistsPorCategoria,
  calcularChecklistsPorSetor,
  calcularDemandaPorHora,
  calcularEvolucaoConformidade,
  calcularEvolucaoDiaria,
  calcularIndicadoresBloqueios,
  calcularIndicadoresSeguranca,
  calcularItensChecklistCriticos,
  calcularNaoConformidadePorPlataforma,
  calcularRankingPlataformas,
  calcularRankingSetores,
  calcularRelacaoReservaChecklist,
  calcularTaxasChecklist,
  calcularTempoMedioAprovacaoHoras,
  calcularTempoMedioConclusaoChecklistHoras,
  calcularTendenciaMensal,
  calcularTotaisOperacionais,
  calcularUtilizacaoPlataformas,
  contarPorChave,
  type BloqueioComMotivo,
  type BloqueioIntervalo,
  type ChecklistFinalizado,
  type ChecklistResumo,
  type DecisaoAprovacao,
  type OcorrenciaResumo,
  type PlataformaResumo,
  type ReservaChecklistResumo,
  type ReservaDuracao,
  type ReservaOperacional,
  type RespostaNaoConformeResumo,
  type SetorResumo,
} from "../../services/relatorio.service.js";

// S13 — RF-REL-01: período de 2 dias (2026-08-01 a 2026-08-02) = 48h totais.
const PERIODO = { dateFrom: "2026-08-01", dateTo: "2026-08-02" };

describe("calcularUtilizacaoPlataformas (RF-REL-01)", () => {
  const plataformas: PlataformaResumo[] = [
    { id: "P1", codigo: "PLT-001", nome: "Plataforma A", categoria: "elevatoria" },
    { id: "P2", codigo: "PLT-002", nome: "Plataforma B", categoria: "sala" },
  ];

  it("desconta bloqueio de agenda do tempo disponível e soma só reservas ocupando a plataforma (agendada/em_uso/concluida)", () => {
    const reservas: ReservaDuracao[] = [
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "08:00", horaFim: "11:00", status: "agendada" }, // 3h
      { plataformaId: "P1", data: "2026-08-02", horaInicio: "09:00", horaFim: "10:30", status: "concluida" }, // 1.5h
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "12:00", horaFim: "13:00", status: "pendente" }, // ignorada (não ocupa)
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "14:00", horaFim: "15:00", status: "rejeitada" }, // ignorada
      { plataformaId: "P2", data: "2026-08-01", horaInicio: "08:00", horaFim: "20:00", status: "cancelada" }, // ignorada (P2)
    ];
    // Bloqueio de 4h (00:00–04:00 de 01/08, horário civil de Brasília) só para P1.
    const bloqueios: BloqueioIntervalo[] = [
      {
        plataformaId: "P1",
        dataInicio: combinarDataHoraBrasilia("2026-08-01", "00:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-01", "04:00"),
      },
    ];

    const resultado = calcularUtilizacaoPlataformas(plataformas, reservas, bloqueios, PERIODO);

    expect(resultado).toEqual([
      {
        plataformaId: "P1",
        codigo: "PLT-001",
        nome: "Plataforma A",
        categoria: "elevatoria",
        horasDisponiveis: 44, // 48 - 4 de bloqueio
        horasReservadas: 4.5, // 3 + 1.5
        taxaUtilizacao: 10.23, // 4.5 / 44 * 100 = 10.2272... → 10.23
      },
      {
        plataformaId: "P2",
        codigo: "PLT-002",
        nome: "Plataforma B",
        categoria: "sala",
        horasDisponiveis: 48, // sem bloqueio
        horasReservadas: 0, // única reserva está "cancelada" (não ocupa)
        taxaUtilizacao: 0,
      },
    ]);
  });

  it("bloqueio global (plataformaId=null) desconta de TODAS as plataformas, sem contar duas vezes horas sobrepostas com um bloqueio específico", () => {
    const reservas: ReservaDuracao[] = [];
    const bloqueios: BloqueioIntervalo[] = [
      // Global: 6h (00:00–06:00 de 01/08, horário civil de Brasília).
      {
        plataformaId: null,
        dataInicio: combinarDataHoraBrasilia("2026-08-01", "00:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-01", "06:00"),
      },
      // Específico de P1, sobreposto ao global (02:00–04:00) — não deve somar horas extras.
      {
        plataformaId: "P1",
        dataInicio: combinarDataHoraBrasilia("2026-08-01", "02:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-01", "04:00"),
      },
    ];

    const resultado = calcularUtilizacaoPlataformas(plataformas, reservas, bloqueios, PERIODO);

    expect(resultado.find((r) => r.plataformaId === "P1")?.horasDisponiveis).toBe(42); // 48 - 6 (união, não 48-6-2)
    expect(resultado.find((r) => r.plataformaId === "P2")?.horasDisponiveis).toBe(42); // só o bloqueio global se aplica
  });

  it("bloqueio que ultrapassa os limites do período é clipado (não gera horasDisponiveis negativas)", () => {
    const reservas: ReservaDuracao[] = [];
    // Bloqueio começa antes do período e termina depois — cobre o período inteiro.
    const bloqueios: BloqueioIntervalo[] = [
      {
        plataformaId: "P1",
        dataInicio: combinarDataHoraBrasilia("2026-07-20", "00:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-20", "00:00"),
      },
    ];

    const resultado = calcularUtilizacaoPlataformas(plataformas, reservas, bloqueios, PERIODO);

    expect(resultado.find((r) => r.plataformaId === "P1")?.horasDisponiveis).toBe(0);
  });
});

describe("calcularRankingSetores (RF-REL-02)", () => {
  it("calcula volume e taxa de rejeição exatos, ordenado por volume desc", () => {
    const setores: SetorResumo[] = [
      { id: "S1", nome: "TI", corHex: "#2563EB" },
      { id: "S2", nome: "Manutenção", corHex: "#D97706" },
      { id: "S3", nome: "Qualidade", corHex: "#065F46" },
    ];
    const reservas = [
      { setorId: "S1", status: "agendada" as const },
      { setorId: "S1", status: "concluida" as const },
      { setorId: "S1", status: "rejeitada" as const },
      { setorId: "S1", status: "pendente" as const },
      { setorId: "S2", status: "agendada" as const },
      { setorId: "S2", status: "concluida" as const },
      // S3 sem nenhuma reserva no período.
    ];

    const resultado = calcularRankingSetores(setores, reservas);

    expect(resultado).toEqual([
      { setorId: "S1", setorNome: "TI", corHex: "#2563EB", totalReservas: 4, totalRejeitadas: 1, taxaRejeicao: 25 },
      { setorId: "S2", setorNome: "Manutenção", corHex: "#D97706", totalReservas: 2, totalRejeitadas: 0, taxaRejeicao: 0 },
      { setorId: "S3", setorNome: "Qualidade", corHex: "#065F46", totalReservas: 0, totalRejeitadas: 0, taxaRejeicao: 0 },
    ]);
  });
});

describe("calcularTempoMedioAprovacaoHoras (RF-REL-03)", () => {
  it("calcula a média exata em horas entre criado_em e a decisão final", () => {
    const decisoes: DecisaoAprovacao[] = [
      { criadoEm: new Date("2026-08-01T00:00:00.000Z"), decididoEm: new Date("2026-08-01T02:00:00.000Z") }, // 2h
      { criadoEm: new Date("2026-08-01T00:00:00.000Z"), decididoEm: new Date("2026-08-01T05:00:00.000Z") }, // 5h
    ];
    expect(calcularTempoMedioAprovacaoHoras(decisoes)).toBe(3.5);
  });

  it("retorna null quando não há nenhuma decisão no período (evita divisão por zero)", () => {
    expect(calcularTempoMedioAprovacaoHoras([])).toBeNull();
  });
});

describe("contarPorChave — distribuição por status/prioridade/categoria (RF-REL-03/04)", () => {
  it("conta cada status na ordem fixa do enum, incluindo chaves com quantidade 0", () => {
    const valores: Array<(typeof STATUS_RESERVA)[number]> = ["agendada", "pendente", "agendada", "rejeitada"];
    const resultado = contarPorChave(valores, STATUS_RESERVA);

    // A ordem segue STATUS_RESERVA, que passou a refletir o fluxo real
    // (agendada → em_uso → concluida, com cancelada terminal). Os dois legados
    // — pendente e rejeitada — vão para o fim: continuam sendo contados, porque o
    // histórico os contém, mas não abrem mais a distribuição.
    expect(resultado).toEqual([
      { chave: "agendada", quantidade: 2 },
      { chave: "em_uso", quantidade: 0 },
      { chave: "concluida", quantidade: 0 },
      { chave: "cancelada", quantidade: 0 },
      { chave: "pendente", quantidade: 1 },
      { chave: "rejeitada", quantidade: 1 },
    ]);
  });
});

describe("calcularTendenciaMensal (RF-REL-04)", () => {
  it("agrupa por mês de criação (YYYY-MM) em ordem cronológica ascendente", () => {
    const datas = [
      new Date("2026-01-15T10:00:00.000Z"),
      new Date("2026-01-20T10:00:00.000Z"),
      new Date("2026-02-01T10:00:00.000Z"),
    ];
    expect(calcularTendenciaMensal(datas)).toEqual([
      { mes: "2026-01", quantidade: 2 },
      { mes: "2026-02", quantidade: 1 },
    ]);
  });

  it("atravessa a virada de ano corretamente", () => {
    const datas = [new Date("2026-12-30T00:00:00.000Z"), new Date("2027-01-02T00:00:00.000Z")];
    expect(calcularTendenciaMensal(datas)).toEqual([
      { mes: "2026-12", quantidade: 1 },
      { mes: "2027-01", quantidade: 1 },
    ]);
  });
});

describe("calcularIndicadoresSeguranca (RF-REL-05)", () => {
  it("calcula o percentual exato de checklists não conformes e agrupa ocorrências por plataforma/gravidade", () => {
    const checklists: ChecklistResumo[] = [
      { todosConformes: true },
      { todosConformes: false },
      { todosConformes: false },
      { todosConformes: true },
    ];
    const ocorrencias: OcorrenciaResumo[] = [
      { plataformaId: "P1", plataformaNome: "Plataforma A", gravidade: "alta" },
      { plataformaId: "P1", plataformaNome: "Plataforma A", gravidade: "baixa" },
      { plataformaId: "P2", plataformaNome: "Plataforma B", gravidade: "media" },
    ];

    const resultado = calcularIndicadoresSeguranca(checklists, ocorrencias);

    expect(resultado).toEqual({
      totalChecklists: 4,
      totalChecklistsNaoConformes: 2,
      percentualChecklistNaoConforme: 50,
      ocorrenciasPorPlataforma: [
        { plataformaId: "P1", plataformaNome: "Plataforma A", baixa: 1, media: 0, alta: 1, total: 2 },
        { plataformaId: "P2", plataformaNome: "Plataforma B", baixa: 0, media: 1, alta: 0, total: 1 },
      ],
    });
  });

  it("retorna 0% quando não há nenhum checklist no período (evita divisão por zero)", () => {
    const resultado = calcularIndicadoresSeguranca([], []);
    expect(resultado.percentualChecklistNaoConforme).toBe(0);
    expect(resultado.totalChecklists).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — Visão Geral / Uso da Frota
// ---------------------------------------------------------------------------

describe("calcularTotaisOperacionais (expansão de Relatórios)", () => {
  it("conta total de reservas (qualquer status), soma horas só das que ocupam a plataforma, e calcula taxa de cancelamento", () => {
    const reservas: ReservaOperacional[] = [
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "08:00", horaFim: "10:00", status: "agendada" }, // 2h
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "10:00", horaFim: "11:00", status: "concluida" }, // 1h
      { plataformaId: "P1", data: "2026-08-02", horaInicio: "09:00", horaFim: "10:00", status: "cancelada" },
      { plataformaId: "P1", data: "2026-08-02", horaInicio: "11:00", horaFim: "12:00", status: "rejeitada" },
      { plataformaId: "P1", data: "2026-08-03", horaInicio: "13:00", horaFim: "14:00", status: "pendente" },
    ];
    expect(calcularTotaisOperacionais(reservas)).toEqual({
      totalReservas: 5,
      horasReservadasTotais: 3,
      totalCanceladas: 1,
      taxaCancelamento: 20,
    });
  });

  it("retorna 0 em tudo quando não há reservas (evita divisão por zero)", () => {
    expect(calcularTotaisOperacionais([])).toEqual({
      totalReservas: 0,
      horasReservadasTotais: 0,
      totalCanceladas: 0,
      taxaCancelamento: 0,
    });
  });
});

describe("calcularEvolucaoDiaria (expansão de Relatórios — PARTE 14)", () => {
  it("inclui todo dia do período, mesmo sem reserva, e soma quantidade/horas por dia", () => {
    const periodo = { dateFrom: "2026-08-01", dateTo: "2026-08-03" };
    const reservas: ReservaOperacional[] = [
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "08:00", horaFim: "10:00", status: "agendada" },
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "10:00", horaFim: "11:00", status: "pendente" },
      { plataformaId: "P1", data: "2026-08-03", horaInicio: "09:00", horaFim: "09:30", status: "concluida" },
    ];
    expect(calcularEvolucaoDiaria(reservas, periodo)).toEqual([
      { data: "2026-08-01", quantidadeReservas: 2, horasReservadas: 2 },
      { data: "2026-08-02", quantidadeReservas: 0, horasReservadas: 0 },
      { data: "2026-08-03", quantidadeReservas: 1, horasReservadas: 0.5 },
    ]);
  });
});

describe("calcularDemandaPorHora (expansão de Relatórios — PARTE 16)", () => {
  it("soma +1 em cada hora civil coberta pela reserva, ignorando reservas que não ocupam a plataforma", () => {
    const reservas: ReservaOperacional[] = [
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "08:00", horaFim: "10:00", status: "agendada" },
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "09:30", horaFim: "10:30", status: "em_uso" },
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "14:00", horaFim: "15:00", status: "rejeitada" },
    ];
    const resultado = calcularDemandaPorHora(reservas);
    expect(resultado).toHaveLength(24);
    expect(resultado.find((r) => r.hora === 8)?.quantidade).toBe(1);
    expect(resultado.find((r) => r.hora === 9)?.quantidade).toBe(2);
    expect(resultado.find((r) => r.hora === 10)?.quantidade).toBe(1);
    expect(resultado.find((r) => r.hora === 14)?.quantidade).toBe(0);
  });
});

describe("calcularRankingPlataformas (expansão de Relatórios — PARTE 17)", () => {
  it("ordena por quantidade de reservas desc e omite plataformas sem nenhuma reserva ocupando no período", () => {
    const plataformas: PlataformaResumo[] = [
      { id: "P1", codigo: "PLT-1", nome: "A", categoria: "sala" },
      { id: "P2", codigo: "PLT-2", nome: "B", categoria: "sala" },
      { id: "P3", codigo: "PLT-3", nome: "C", categoria: "sala" },
    ];
    const reservas: ReservaOperacional[] = [
      { plataformaId: "P1", data: "2026-08-01", horaInicio: "08:00", horaFim: "10:00", status: "agendada" },
      { plataformaId: "P1", data: "2026-08-02", horaInicio: "08:00", horaFim: "09:00", status: "concluida" },
      { plataformaId: "P2", data: "2026-08-01", horaInicio: "08:00", horaFim: "09:00", status: "cancelada" },
    ];
    expect(calcularRankingPlataformas(plataformas, reservas)).toEqual([
      { plataformaId: "P1", codigo: "PLT-1", nome: "A", totalReservas: 2, horasReservadas: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — Indisponibilidade
// ---------------------------------------------------------------------------

describe("calcularIndicadoresBloqueios (expansão de Relatórios — PARTE 18)", () => {
  it("soma horas bloqueadas por motivo e distribui a tendência diária, sem deduplicar bloqueios sobrepostos entre si", () => {
    const periodo = { dateFrom: "2026-08-01", dateTo: "2026-08-02" };
    const bloqueios: BloqueioComMotivo[] = [
      {
        plataformaId: "P1",
        dataInicio: combinarDataHoraBrasilia("2026-08-01", "08:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-01", "12:00"),
        motivo: "Manutenção",
      },
      {
        plataformaId: null,
        dataInicio: combinarDataHoraBrasilia("2026-08-01", "10:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-01", "11:00"),
        motivo: "Manutenção",
      },
      {
        plataformaId: "P2",
        dataInicio: combinarDataHoraBrasilia("2026-08-02", "09:00"),
        dataFim: combinarDataHoraBrasilia("2026-08-02", "10:00"),
        motivo: "Feriado",
      },
    ];
    const resultado = calcularIndicadoresBloqueios(bloqueios, periodo);
    expect(resultado.horasBloqueadasTotais).toBe(6);
    expect(resultado.totalBloqueios).toBe(3);
    expect(resultado.porMotivo).toEqual([
      { motivo: "Manutenção", horasBloqueadas: 5, ocorrencias: 2 },
      { motivo: "Feriado", horasBloqueadas: 1, ocorrencias: 1 },
    ]);
    expect(resultado.tendencia).toEqual([
      { data: "2026-08-01", horasBloqueadas: 5 },
      { data: "2026-08-02", horasBloqueadas: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Expansão de Relatórios & Indicadores — Segurança & Checklists
// ---------------------------------------------------------------------------

describe("Indicadores de checklist (expansão de Relatórios — Segurança & Checklists)", () => {
  const finalizados: ChecklistFinalizado[] = [
    {
      plataformaId: "P1",
      plataformaNome: "Plataforma A",
      categoria: "elevatoria",
      setorId: "S1",
      setorNome: "Manutenção",
      finalizadoEm: new Date("2026-08-03T12:00:00.000Z"),
      todosConformes: true,
      inicioEm: new Date("2026-08-03T11:00:00.000Z"), // 1h de duração
    },
    {
      plataformaId: "P1",
      plataformaNome: "Plataforma A",
      categoria: "elevatoria",
      setorId: "S1",
      setorNome: "Manutenção",
      finalizadoEm: new Date("2026-08-10T12:00:00.000Z"),
      todosConformes: false,
      inicioEm: new Date("2026-08-10T09:00:00.000Z"), // 3h de duração
    },
    {
      plataformaId: "P2",
      plataformaNome: "Plataforma B",
      categoria: "andaime",
      setorId: "S2",
      setorNome: "Produção",
      finalizadoEm: new Date("2026-08-10T15:00:00.000Z"),
      todosConformes: true,
      inicioEm: null, // sem registro de auditoria (dado histórico incompleto) — excluído do tempo médio
    },
  ];

  it("calcularTaxasChecklist: taxa de conclusão sobre o universo exigido, taxa de conformidade só sobre os concluídos", () => {
    expect(calcularTaxasChecklist(4, finalizados)).toEqual({
      totalExigidos: 4,
      totalConcluidos: 3,
      taxaConclusao: 75,
      totalConformes: 2,
      totalNaoConformes: 1,
      taxaConformidade: 66.67,
    });
  });

  it("calcularTaxasChecklist: 0% quando não há checklists exigidos no período (evita divisão por zero)", () => {
    expect(calcularTaxasChecklist(0, [])).toEqual({
      totalExigidos: 0,
      totalConcluidos: 0,
      taxaConclusao: 0,
      totalConformes: 0,
      totalNaoConformes: 0,
      taxaConformidade: 0,
    });
  });

  it("calcularTempoMedioConclusaoChecklistHoras: média só entre os checklists com início conhecido (nunca estimado)", () => {
    expect(calcularTempoMedioConclusaoChecklistHoras(finalizados)).toBe(2); // (1h + 3h) / 2
  });

  it("calcularTempoMedioConclusaoChecklistHoras: null quando nenhum checklist tem início conhecido", () => {
    expect(calcularTempoMedioConclusaoChecklistHoras([finalizados[2]])).toBeNull();
  });

  it("calcularEvolucaoConformidade: agrupa por semana (segunda-feira) com taxa de conformidade da semana", () => {
    expect(calcularEvolucaoConformidade(finalizados)).toEqual([
      { semanaInicio: "2026-08-03", taxaConformidade: 100, totalFinalizados: 1 },
      { semanaInicio: "2026-08-10", taxaConformidade: 50, totalFinalizados: 2 },
    ]);
  });

  it("calcularNaoConformidadePorPlataforma: só lista plataformas com pelo menos uma não conformidade", () => {
    expect(calcularNaoConformidadePorPlataforma(finalizados)).toEqual([
      { plataformaId: "P1", plataformaNome: "Plataforma A", naoConformidades: 1 },
    ]);
  });

  it("calcularItensChecklistCriticos: ranking dos itens com mais respostas não conforme", () => {
    const respostas: RespostaNaoConformeResumo[] = [
      { itemDescricao: "Guarda-corpo em condições adequadas" },
      { itemDescricao: "Guarda-corpo em condições adequadas" },
      { itemDescricao: "Sistema de emergência funcional" },
    ];
    expect(calcularItensChecklistCriticos(respostas)).toEqual([
      { itemDescricao: "Guarda-corpo em condições adequadas", ocorrencias: 2 },
      { itemDescricao: "Sistema de emergência funcional", ocorrencias: 1 },
    ]);
  });

  it("calcularChecklistsPorCategoria: agrupa realizados/conformes/não conformes por categoria de plataforma", () => {
    expect(calcularChecklistsPorCategoria(finalizados)).toEqual([
      { categoria: "elevatoria", totalRealizados: 2, totalConformes: 1, totalNaoConformes: 1 },
      { categoria: "andaime", totalRealizados: 1, totalConformes: 1, totalNaoConformes: 0 },
    ]);
  });

  it("calcularChecklistsPorSetor: agrupa realizados/conformes/não conformes por setor", () => {
    expect(calcularChecklistsPorSetor(finalizados)).toEqual([
      { setorId: "S1", setorNome: "Manutenção", totalRealizados: 2, totalConformes: 1, totalNaoConformes: 1 },
      { setorId: "S2", setorNome: "Produção", totalRealizados: 1, totalConformes: 1, totalNaoConformes: 0 },
    ]);
  });

  it("calcularRelacaoReservaChecklist: exigiam / com checklist realizado / iniciadas após checklist", () => {
    const reservas: ReservaChecklistResumo[] = [
      { status: "concluida", requerChecklist: true, checklistFinalizado: true },
      { status: "em_uso", requerChecklist: true, checklistFinalizado: true },
      { status: "pendente", requerChecklist: true, checklistFinalizado: false },
      { status: "agendada", requerChecklist: false, checklistFinalizado: false },
    ];
    expect(calcularRelacaoReservaChecklist(reservas)).toEqual({
      reservasQueExigiamChecklist: 3,
      reservasComChecklistRealizado: 2,
      reservasIniciadasAposChecklist: 2,
    });
  });
});
