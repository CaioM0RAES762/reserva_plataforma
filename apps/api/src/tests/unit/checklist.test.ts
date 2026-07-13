import { describe, expect, it } from "vitest";
import {
  calcularTodosConformes,
  ItemObrigatorioNaoRespondidoError,
  ObservacaoObrigatoriaError,
  requerChecklist,
  validarRespostasChecklist,
  type ItemTemplateChecklist,
  type RespostaChecklist,
} from "../../services/checklist.service.js";

const ITEM_1: ItemTemplateChecklist = { itemId: "item-1", obrigatorio: true };
const ITEM_2: ItemTemplateChecklist = { itemId: "item-2", obrigatorio: true };
const ITEM_OPCIONAL: ItemTemplateChecklist = { itemId: "item-opcional", obrigatorio: false };

describe("requerChecklist (SDD §2.4/RN-RES-12)", () => {
  it("elevatória exige checklist", () => {
    expect(requerChecklist("elevatoria")).toBe(true);
  });

  it("andaime exige checklist", () => {
    expect(requerChecklist("andaime")).toBe(true);
  });

  it("sala não exige checklist", () => {
    expect(requerChecklist("sala")).toBe(false);
  });

  it("pátio não exige checklist", () => {
    expect(requerChecklist("patio")).toBe(false);
  });

  it("veículo não exige checklist nesta sprint (S8 cobre só elevatória/andaime)", () => {
    expect(requerChecklist("veiculo")).toBe(false);
  });

  it("outro não exige checklist", () => {
    expect(requerChecklist("outro")).toBe(false);
  });
});

describe("validarRespostasChecklist — RN-CHK-01", () => {
  it("item obrigatório sem resposta -> lança ItemObrigatorioNaoRespondidoError", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-1", conforme: true }];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2], respostas)).toThrow(
      ItemObrigatorioNaoRespondidoError
    );
  });

  it("item não conforme sem observação -> lança ObservacaoObrigatoriaError", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: false, observacao: "" },
    ];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2], respostas)).toThrow(
      ObservacaoObrigatoriaError
    );
  });

  it("item não conforme com observação só de espaços -> ainda lança ObservacaoObrigatoriaError (trim)", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: false, observacao: "   " },
    ];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2], respostas)).toThrow(
      ObservacaoObrigatoriaError
    );
  });

  it("item não conforme com observação preenchida -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: false, observacao: "Vazamento visível na mangueira." },
    ];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2], respostas)).not.toThrow();
  });

  it("item opcional (obrigatorio=false) sem resposta -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: true },
    ];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2, ITEM_OPCIONAL], respostas)).not.toThrow();
  });

  it("todos os itens obrigatórios respondidos e conformes -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: true },
    ];
    expect(() => validarRespostasChecklist([ITEM_1, ITEM_2], respostas)).not.toThrow();
  });
});

describe("calcularTodosConformes — RN-CHK-02", () => {
  it("todos os itens obrigatórios conformes -> true", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: true },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(true);
  });

  it("um item obrigatório não conforme -> false (cenário misto)", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: false, observacao: "Freio não trava corretamente." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(false);
  });

  it("item obrigatório sem resposta -> false (cenário misto — não assume conforme por omissão)", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-1", conforme: true }];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(false);
  });

  it("item opcional não conforme não afeta o cálculo (só itens obrigatórios contam)", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: true },
      { itemId: "item-2", conforme: true },
      { itemId: "item-opcional", conforme: false, observacao: "Detalhe estético, sem risco." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2, ITEM_OPCIONAL], respostas)).toBe(true);
  });

  it("nenhum item obrigatório no template -> true (nada bloqueia)", () => {
    expect(calcularTodosConformes([ITEM_OPCIONAL], [])).toBe(true);
  });

  it("todos os itens obrigatórios não conformes -> false", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", conforme: false, observacao: "Guarda-corpo solto." },
      { itemId: "item-2", conforme: false, observacao: "Freio não trava corretamente." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(false);
  });
});
