import { describe, expect, it } from "vitest";
import {
  ATALHOS_DURACAO_MINUTOS,
  calcularIntervalosLivres,
  calcularJanelaGrade,
  duracoesRapidasPermitidas,
  fimMaximoPossivel,
  horaParaMinutos,
  inicioDeSlotsLivres,
  intervaloCabeNosLivres,
  mesclarIntervalos,
  minutosParaHora,
  ULTIMO_MINUTO_RESERVAVEL,
  type FaixaMinutos,
} from "@plataformares/shared";

// Aritmética pura de janelas (packages/shared/src/disponibilidade.ts): é ela que Calendário,
// Nova Reserva e a API compartilham. Estes testes travam os limites que, errados, deixariam
// a tela oferecer um horário que o POST /reservas recusaria.

const h = horaParaMinutos;

describe("horaParaMinutos / minutosParaHora", () => {
  it("converte os extremos do dia", () => {
    expect(horaParaMinutos("00:00")).toBe(0);
    expect(horaParaMinutos("23:59")).toBe(1439);
    expect(minutosParaHora(0)).toBe("00:00");
    expect(minutosParaHora(1439)).toBe("23:59");
  });

  it("aceita 1440 só como rótulo de fim de grade (24:00)", () => {
    expect(minutosParaHora(1440)).toBe("24:00");
  });
});

describe("calcularJanelaGrade", () => {
  it("expediente 00:00–23:59: linhas 00..23 e a grade termina em 24:00 (a última hora não some)", () => {
    const janela = calcularJanelaGrade("00:00", "23:59");
    expect(janela.inicioHora).toBe(0);
    expect(janela.fimHora).toBe(24);
    expect(janela.horas).toHaveLength(24);
    expect(janela.horas[0]).toBe(0);
    expect(janela.horas[23]).toBe(23);
    expect(janela.inicioMin).toBe(0);
    expect(janela.fimMin).toBe(1440);
  });

  it("expediente 06:00–18:00: linhas 06..17, grade termina exatamente às 18:00", () => {
    const janela = calcularJanelaGrade("06:00", "18:00");
    expect(janela.horas).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(janela.inicioMin).toBe(360);
    expect(janela.fimMin).toBe(1080);
  });

  it("expediente 06:00–18:30: fim arredonda PARA CIMA (linha das 18h existe, grade vai até 19:00)", () => {
    const janela = calcularJanelaGrade("06:00", "18:30");
    expect(janela.horas[janela.horas.length - 1]).toBe(18);
    expect(janela.fimHora).toBe(19);
    expect(janela.fimMin).toBe(1140);
  });

  it("início fora da hora cheia arredonda para baixo (06:45 mantém a linha das 6h)", () => {
    const janela = calcularJanelaGrade("06:45", "12:00");
    expect(janela.inicioHora).toBe(6);
    expect(janela.horas[0]).toBe(6);
  });

  it("expediente degenerado (fim <= início) ainda devolve ao menos uma linha", () => {
    const janela = calcularJanelaGrade("10:00", "10:00");
    expect(janela.horas).toEqual([10]);
  });
});

describe("mesclarIntervalos", () => {
  it("funde sobreposições e adjacências, ordena e não muta a entrada", () => {
    const entrada: FaixaMinutos[] = [
      { inicioMin: 600, fimMin: 660 },
      { inicioMin: 480, fimMin: 540 },
      { inicioMin: 540, fimMin: 570 },
      { inicioMin: 700, fimMin: 700 },
    ];
    const copia = JSON.parse(JSON.stringify(entrada));
    expect(mesclarIntervalos(entrada)).toEqual([
      { inicioMin: 480, fimMin: 570 },
      { inicioMin: 600, fimMin: 660 },
    ]);
    expect(entrada).toEqual(copia);
  });
});

describe("calcularIntervalosLivres", () => {
  const expediente: FaixaMinutos = { inicioMin: h("06:00"), fimMin: h("18:00") };

  it("sem ocupação, o expediente inteiro é livre", () => {
    expect(calcularIntervalosLivres([], expediente)).toEqual([expediente]);
  });

  it("subtrai reservas e bloqueios do expediente", () => {
    const livres = calcularIntervalosLivres(
      [
        { inicioMin: h("08:00"), fimMin: h("10:00") },
        { inicioMin: h("12:00"), fimMin: h("13:00") },
      ],
      expediente
    );
    expect(livres).toEqual([
      { inicioMin: h("06:00"), fimMin: h("08:00") },
      { inicioMin: h("10:00"), fimMin: h("12:00") },
      { inicioMin: h("13:00"), fimMin: h("18:00") },
    ]);
  });

  it("ocupação que invade o fim do expediente nunca estende o livre além dele", () => {
    const livres = calcularIntervalosLivres([{ inicioMin: h("17:00"), fimMin: h("20:00") }], expediente);
    expect(livres).toEqual([{ inicioMin: h("06:00"), fimMin: h("17:00") }]);
  });

  it("ocupação que começa antes do expediente corta o começo dele", () => {
    const livres = calcularIntervalosLivres([{ inicioMin: h("04:00"), fimMin: h("07:30") }], expediente);
    expect(livres).toEqual([{ inicioMin: h("07:30"), fimMin: h("18:00") }]);
  });

  it("apartirDeMin (agora + antecedência) descarta o que começaria antes dele", () => {
    const livres = calcularIntervalosLivres(
      [{ inicioMin: h("08:00"), fimMin: h("10:00") }],
      expediente,
      h("09:00")
    );
    expect(livres).toEqual([{ inicioMin: h("10:00"), fimMin: h("18:00") }]);
  });

  it("apartirDeMin depois do fim do expediente não deixa nada livre", () => {
    expect(calcularIntervalosLivres([], expediente, h("18:00"))).toEqual([]);
  });

  it("dia inteiro ocupado (bloqueio 00:00–24:00) não deixa nada livre", () => {
    expect(calcularIntervalosLivres([{ inicioMin: 0, fimMin: 1440 }], { inicioMin: 0, fimMin: 1439 })).toEqual([]);
  });
});

describe("inicioDeSlotsLivres", () => {
  it("lista os inícios de 30 em 30 que ainda comportam a duração", () => {
    const inicios = inicioDeSlotsLivres([{ inicioMin: h("06:00"), fimMin: h("08:00") }], 30, 60);
    expect(inicios).toEqual([h("06:00"), h("06:30"), h("07:00")]);
  });

  it("um trecho livre que começa fora da grade oferece o início exato e depois a grade", () => {
    const inicios = inicioDeSlotsLivres([{ inicioMin: h("13:10"), fimMin: h("15:00") }], 30, 60);
    expect(inicios).toEqual([h("13:10"), h("13:30"), h("14:00")]);
  });

  it("não oferece início quando a duração não cabe no trecho", () => {
    expect(inicioDeSlotsLivres([{ inicioMin: h("10:00"), fimMin: h("10:45") }], 30, 60)).toEqual([]);
  });

  it("trecho fora da grade curto demais para a duração também não é oferecido", () => {
    expect(inicioDeSlotsLivres([{ inicioMin: h("13:10"), fimMin: h("13:50") }], 30, 60)).toEqual([]);
  });
});

describe("fimMaximoPossivel", () => {
  const livres: FaixaMinutos[] = [{ inicioMin: h("08:00"), fimMin: h("10:30") }];

  it("é o menor entre o fim do trecho livre e a duração máxima", () => {
    expect(fimMaximoPossivel(h("08:00"), livres, 12 * 60)).toBe(h("10:30"));
    expect(fimMaximoPossivel(h("08:00"), livres, 90)).toBe(h("09:30"));
  });

  it("null quando o início cai fora de qualquer trecho livre", () => {
    expect(fimMaximoPossivel(h("07:00"), livres, 720)).toBeNull();
    expect(fimMaximoPossivel(h("10:30"), livres, 720)).toBeNull();
  });

  it("nunca passa de 23:59, mesmo com o dia inteiro livre", () => {
    expect(fimMaximoPossivel(h("20:00"), [{ inicioMin: 0, fimMin: 1440 }], 24 * 60)).toBe(ULTIMO_MINUTO_RESERVAVEL);
  });
});

describe("duracoesRapidasPermitidas", () => {
  it("só oferece os atalhos (1h/2h/4h) que cabem no trecho livre", () => {
    const livres = [{ inicioMin: h("08:00"), fimMin: h("10:30") }];
    expect(duracoesRapidasPermitidas(h("08:00"), livres, 720)).toEqual([60, 120]);
    expect(duracoesRapidasPermitidas(h("09:30"), livres, 720)).toEqual([60]);
  });

  it("respeita a duração máxima configurada", () => {
    const livres = [{ inicioMin: h("06:00"), fimMin: h("18:00") }];
    expect(duracoesRapidasPermitidas(h("06:00"), livres, 90)).toEqual([60]);
  });

  it("início dentro de uma ocupação não tem atalho algum", () => {
    const livres = [{ inicioMin: h("10:00"), fimMin: h("18:00") }];
    expect(duracoesRapidasPermitidas(h("09:00"), livres, 720)).toEqual([]);
  });

  it("perto da meia-noite, o teto de 23:59 tira o atalho que passaria dele", () => {
    // 23:00 + 1h = 24:00, que HH:mm não expressa — a reserva só vai até 23:59.
    expect(duracoesRapidasPermitidas(h("23:00"), [{ inicioMin: 0, fimMin: 1440 }], 24 * 60)).toEqual([]);
    expect(duracoesRapidasPermitidas(h("22:00"), [{ inicioMin: 0, fimMin: 1440 }], 24 * 60)).toEqual([60]);
  });

  it("propriedade: nenhum atalho ultrapassa a próxima ocupação, o expediente nem a duração máxima", () => {
    const expediente: FaixaMinutos = { inicioMin: h("06:00"), fimMin: h("18:30") };
    const ocupados: FaixaMinutos[] = [
      { inicioMin: h("09:00"), fimMin: h("10:00") },
      { inicioMin: h("13:20"), fimMin: h("14:00") },
      { inicioMin: h("17:00"), fimMin: h("20:00") },
    ];
    const livres = calcularIntervalosLivres(ocupados, expediente);
    const duracaoMaxima = 180;

    for (let inicio = expediente.inicioMin; inicio < expediente.fimMin; inicio += 15) {
      const proximaOcupacao = ocupados
        .filter((o) => o.inicioMin >= inicio)
        .reduce((menor, o) => Math.min(menor, o.inicioMin), Infinity);
      for (const duracao of duracoesRapidasPermitidas(inicio, livres, duracaoMaxima)) {
        const fim = inicio + duracao;
        expect(ATALHOS_DURACAO_MINUTOS as readonly number[]).toContain(duracao);
        expect(fim).toBeLessThanOrEqual(proximaOcupacao);
        expect(fim).toBeLessThanOrEqual(expediente.fimMin);
        expect(duracao).toBeLessThanOrEqual(duracaoMaxima);
        expect(intervaloCabeNosLivres({ inicioMin: inicio, fimMin: fim }, livres)).toBe(true);
      }
    }
  });
});

describe("intervaloCabeNosLivres", () => {
  const livres = [
    { inicioMin: 480, fimMin: 600 },
    { inicioMin: 660, fimMin: 720 },
  ];

  it("cabe inteiro em um trecho", () => {
    expect(intervaloCabeNosLivres({ inicioMin: 480, fimMin: 600 }, livres)).toBe(true);
  });

  it("não cabe atravessando dois trechos separados por uma ocupação", () => {
    expect(intervaloCabeNosLivres({ inicioMin: 540, fimMin: 700 }, livres)).toBe(false);
  });
});
