import { describe, expect, it } from "vitest";
import type { DisponibilidadeDiaResposta, IntervaloOcupadoDisponibilidade } from "@plataformares/shared";
import {
  calcularAgendaPlataforma,
  conflitosComReservasConfirmadas,
  decidirInicioDigitado,
  selecaoValida,
  textoParaSelecaoExterna,
  type AgendaPlataforma,
  type PrioridadeReserva,
} from "./SeletorHorarioCalculos";

const PLATAFORMA = "11111111-1111-4111-8111-111111111111";
const DATA = "2099-03-10"; // data futura: sem corte de antecedência
const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function reserva(
  id: string,
  inicio: string,
  fim: string,
  status: IntervaloOcupadoDisponibilidade["status"],
  prioridade = "normal"
): IntervaloOcupadoDisponibilidade {
  return { tipo: "reserva", id, inicioMin: min(inicio), fimMin: min(fim), status, setorNome: "Almoxarifado", prioridade };
}

function agendaCom(intervalos: IntervaloOcupadoDisponibilidade[], prioridade: PrioridadeReserva = "normal"): AgendaPlataforma {
  const dados: DisponibilidadeDiaResposta = {
    data: DATA,
    regras: { horarioExpedienteInicio: "00:00", horarioExpedienteFim: "23:59", duracaoMaximaHoras: 12, antecedenciaMinimaHoras: 1 },
    agoraMin: null,
    inicioMinimoMin: 0,
    plataformas: [
      {
        id: PLATAFORMA,
        codigo: "PLT-S11-DEMO",
        nome: "Plataforma",
        categoria: "outro",
        localizacao: null,
        status: "disponivel",
        capacidadeOperadores: null,
        indisponivel: false,
        intervalos,
      },
    ],
  };
  return calcularAgendaPlataforma(dados, PLATAFORMA, prioridade, new Date("2099-03-01T12:00:00Z"))!;
}

/* Simula o campo exatamente como o SeletorHorario o executa: cada valor que o
   <input type="time"> emite passa por decidirInicioDigitado; cada mudança da seleção passa por
   textoParaSelecaoExterna; a agenda recalculada reavalia o texto atual. */
class CampoSimulado {
  texto = "";
  selecao: number | null = null;
  emitido: number | null = null;
  constructor(public agenda: AgendaPlataforma) {}

  private mudarSelecao(nova: number | null) {
    this.selecao = nova;
    const texto = textoParaSelecaoExterna(this.selecao, this.emitido);
    if (texto !== null) {
      this.emitido = null;
      this.texto = texto;
    }
  }
  private aplicar() {
    const decisao = decidirInicioDigitado(this.agenda, this.texto, this.selecao);
    if (decisao.acao === "invalidar") {
      this.emitido = null;
      this.mudarSelecao(null);
    } else if (decisao.acao === "aplicar") {
      this.emitido = decisao.inicioMin;
      this.mudarSelecao(decisao.inicioMin);
    }
  }
  digitar(...valoresEmitidos: string[]) {
    for (const valor of valoresEmitidos) {
      this.texto = valor;
      this.aplicar();
    }
  }
  recalcularAgenda(agenda: AgendaPlataforma) {
    this.agenda = agenda;
    this.aplicar();
  }
  escolherChip(inicioMin: number) {
    this.mudarSelecao(inicioMin);
  }
}

describe("horário personalizado — o valor digitado é estável (bug 10:40 → 10:04)", () => {
  const livre = agendaCom([]);

  // 23:59 é o fim máximo de uma reserva, então não é um INÍCIO reservável (nada cabe depois
  // dele): o texto continua exatamente o digitado, mas não vira seleção.
  it.each([
    ["10:04", true],
    ["10:40", true],
    ["09:05", true],
    ["09:50", true],
    ["12:34", true],
    ["23:59", false],
  ] as const)("digitar %s mantém o texto exatamente como digitado", (hora, reservavel) => {
    const campo = new CampoSimulado(livre);
    // O input emite o valor parcial "HH:0d" antes do último dígito; depois o valor final.
    campo.digitar(`${hora.slice(0, 3)}0${hora[3]}`, hora);
    expect(campo.texto).toBe(hora);
    expect(campo.selecao).toBe(reservavel ? min(hora) : null);
    campo.recalcularAgenda(agendaCom([])); // disponibilidade recalculada / SSE / relógio
    expect(campo.texto).toBe(hora);
    expect(campo.selecao).toBe(reservavel ? min(hora) : null);
  });

  it("cenário do bug: 10:40 cai num horário ocupado, 10:04 (parcial) estava livre", () => {
    // Reserva normal 10:30–11:30 e o usuário digita 10:40 (prioridade normal).
    const ocupada = agendaCom([reserva("A", "10:30", "11:30", "agendada")]);
    const campo = new CampoSimulado(ocupada);
    campo.digitar("10:04", "10:40");
    // O texto é o que o usuário escreveu, e o 10:04 intermediário NÃO fica valendo por baixo.
    expect(campo.texto).toBe("10:40");
    expect(campo.selecao).toBeNull();
    // Recalcular a agenda depois (o que antes reescrevia o campo para 10:04) não muda nada.
    campo.recalcularAgenda(agendaCom([reserva("A", "10:30", "11:30", "agendada")]));
    expect(campo.texto).toBe("10:40");
    expect(campo.selecao).toBeNull();
  });

  it("a mesma digitação como URGENTE é aceita sobre a reserva confirmada", () => {
    const campo = new CampoSimulado(agendaCom([reserva("A", "10:30", "11:30", "agendada")], "urgente"));
    campo.digitar("10:04", "10:40");
    expect(campo.texto).toBe("10:40");
    expect(campo.selecao).toBe(min("10:40"));
  });

  it("trocar para urgente depois de digitar aplica o horário escrito (sem reescrevê-lo)", () => {
    const campo = new CampoSimulado(agendaCom([reserva("A", "10:30", "11:30", "agendada")]));
    campo.digitar("10:04", "10:40");
    campo.recalcularAgenda(agendaCom([reserva("A", "10:30", "11:30", "agendada")], "urgente"));
    expect(campo.texto).toBe("10:40");
    expect(campo.selecao).toBe(min("10:40"));
  });

  it("apagar o campo descarta a seleção", () => {
    const campo = new CampoSimulado(livre);
    campo.digitar("09:50");
    campo.digitar("");
    expect(campo.selecao).toBeNull();
  });

  it("mudança externa (chip) continua atualizando o campo", () => {
    const campo = new CampoSimulado(livre);
    campo.digitar("10:04", "10:40");
    campo.escolherChip(min("14:30"));
    expect(campo.texto).toBe("14:30");
    campo.digitar("14:04", "14:40");
    expect(campo.texto).toBe("14:40");
  });
});

describe("agenda do formulário — pendente e urgência", () => {
  it("pendente aparece na lista, mas não ocupa o horário", () => {
    const agenda = agendaCom([reserva("P", "10:30", "11:30", "pendente")]);
    expect(selecaoValida(agenda, { inicioMin: min("10:30"), duracao: 60, fimPersonalizadoMin: null })).toBe(true);
    expect(agenda.ocupacoes).toEqual([expect.objectContaining({ faixa: "10:30–11:30", pendente: true })]);
  });

  it("normal não pode sobrepor reserva confirmada", () => {
    const agenda = agendaCom([reserva("A", "10:30", "11:30", "agendada")]);
    expect(selecaoValida(agenda, { inicioMin: min("10:40"), duracao: "personalizado", fimPersonalizadoMin: min("11:10") })).toBe(false);
  });

  it("TESTE 6 — urgente pode sobrepor reserva confirmada, com o conflito exposto", () => {
    const agenda = agendaCom([reserva("A", "10:30", "11:30", "agendada")], "urgente");
    const selecao = { inicioMin: min("10:40"), duracao: "personalizado" as const, fimPersonalizadoMin: min("11:10") };
    expect(selecaoValida(agenda, selecao)).toBe(true);
    expect(conflitosComReservasConfirmadas(agenda, selecao.inicioMin, selecao.fimPersonalizadoMin)).toEqual([
      expect.objectContaining({ inicioMin: min("10:30"), fimMin: min("11:30") }),
    ]);
  });

  it("urgente continua barrada por bloqueio de agenda", () => {
    const bloqueio: IntervaloOcupadoDisponibilidade = {
      tipo: "bloqueio_plataforma",
      id: "B",
      inicioMin: min("10:00"),
      fimMin: min("12:00"),
      motivo: "Inspeção",
    };
    const agenda = agendaCom([bloqueio], "urgente");
    expect(selecaoValida(agenda, { inicioMin: min("10:40"), duracao: 60, fimPersonalizadoMin: null })).toBe(false);
  });
});
