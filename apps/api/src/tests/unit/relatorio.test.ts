import { describe, expect, it } from "vitest";
import { STATUS_RESERVA } from "@plataformares/shared";
import {
  calcularIndicadoresSeguranca,
  calcularRankingSetores,
  calcularTempoMedioAprovacaoHoras,
  calcularTendenciaMensal,
  calcularUtilizacaoPlataformas,
  contarPorChave,
  type BloqueioIntervalo,
  type ChecklistResumo,
  type DecisaoAprovacao,
  type OcorrenciaResumo,
  type PlataformaResumo,
  type ReservaDuracao,
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
    // Bloqueio de 4h (00:00–04:00 de 01/08) só para P1.
    const bloqueios: BloqueioIntervalo[] = [
      { plataformaId: "P1", dataInicio: new Date("2026-08-01T00:00:00.000Z"), dataFim: new Date("2026-08-01T04:00:00.000Z") },
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
      // Global: 6h (00:00–06:00 de 01/08).
      { plataformaId: null, dataInicio: new Date("2026-08-01T00:00:00.000Z"), dataFim: new Date("2026-08-01T06:00:00.000Z") },
      // Específico de P1, sobreposto ao global (02:00–04:00) — não deve somar horas extras.
      { plataformaId: "P1", dataInicio: new Date("2026-08-01T02:00:00.000Z"), dataFim: new Date("2026-08-01T04:00:00.000Z") },
    ];

    const resultado = calcularUtilizacaoPlataformas(plataformas, reservas, bloqueios, PERIODO);

    expect(resultado.find((r) => r.plataformaId === "P1")?.horasDisponiveis).toBe(42); // 48 - 6 (união, não 48-6-2)
    expect(resultado.find((r) => r.plataformaId === "P2")?.horasDisponiveis).toBe(42); // só o bloqueio global se aplica
  });

  it("bloqueio que ultrapassa os limites do período é clipado (não gera horasDisponiveis negativas)", () => {
    const reservas: ReservaDuracao[] = [];
    // Bloqueio começa antes do período e termina depois — cobre o período inteiro.
    const bloqueios: BloqueioIntervalo[] = [
      { plataformaId: "P1", dataInicio: new Date("2026-07-20T00:00:00.000Z"), dataFim: new Date("2026-08-20T00:00:00.000Z") },
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

    expect(resultado).toEqual([
      { chave: "pendente", quantidade: 1 },
      { chave: "agendada", quantidade: 2 },
      { chave: "em_uso", quantidade: 0 },
      { chave: "concluida", quantidade: 0 },
      { chave: "cancelada", quantidade: 0 },
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
