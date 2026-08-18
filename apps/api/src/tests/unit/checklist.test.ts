import { describe, expect, it } from "vitest";
import {
  calcularTodosConformes,
  ItemObrigatorioNaoRespondidoError,
  ObservacaoObrigatoriaError,
  validarObservacoesObrigatorias,
  validarRespostasParaFinalizar,
  type ItemTemplateChecklist,
  type RespostaChecklist,
} from "../../services/checklist.service.js";

// "Esta plataforma exige checklist?" deixou de ser uma função pura sobre a categoria
// (`requerChecklist(categoria)`, removida) e virou a configuração explícita do equipamento,
// lida do banco por `resolverTemplateEfetivo` — coberta nos testes de integração, que é
// onde a configuração por plataforma pode de fato ser exercitada.

const ITEM_1: ItemTemplateChecklist = { itemId: "item-1", obrigatorio: true, bloqueiaAprovacao: true };
const ITEM_2: ItemTemplateChecklist = { itemId: "item-2", obrigatorio: true, bloqueiaAprovacao: true };
const ITEM_OPCIONAL: ItemTemplateChecklist = {
  itemId: "item-opcional",
  obrigatorio: false,
  bloqueiaAprovacao: false,
};
// Obrigatória de responder, mas uma não conformidade nela não impede a aprovação — a
// combinação que antes era impossível de expressar (ex.: "Documentação disponível").
const ITEM_OBRIGATORIO_NAO_IMPEDITIVO: ItemTemplateChecklist = {
  itemId: "item-doc",
  obrigatorio: true,
  bloqueiaAprovacao: false,
};

describe("validarObservacoesObrigatorias — RN-CHK-01 (vale para rascunho e finalização)", () => {
  it("item não conforme sem observação -> lança ObservacaoObrigatoriaError", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "nao_conforme", observacao: "" },
    ];
    expect(() => validarObservacoesObrigatorias(respostas)).toThrow(ObservacaoObrigatoriaError);
  });

  it("item não conforme com observação só de espaços -> ainda lança (trim)", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-2", resultado: "nao_conforme", observacao: "   " }];
    expect(() => validarObservacoesObrigatorias(respostas)).toThrow(ObservacaoObrigatoriaError);
  });

  it("item não conforme com observação preenchida -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-2", resultado: "nao_conforme", observacao: "Vazamento visível na mangueira." },
    ];
    expect(() => validarObservacoesObrigatorias(respostas)).not.toThrow();
  });

  it("item não aplicável não exige observação", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-2", resultado: "nao_aplicavel" }];
    expect(() => validarObservacoesObrigatorias(respostas)).not.toThrow();
  });

  it("item conforme não exige observação", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-1", resultado: "conforme" }];
    expect(() => validarObservacoesObrigatorias(respostas)).not.toThrow();
  });
});

describe("validarRespostasParaFinalizar — RF-CHK-06/RN-CHK-03 (completude, só na finalização)", () => {
  it("item obrigatório sem resposta -> lança ItemObrigatorioNaoRespondidoError", () => {
    const respostas: RespostaChecklist[] = [{ itemId: "item-1", resultado: "conforme" }];
    expect(() => validarRespostasParaFinalizar([ITEM_1, ITEM_2], respostas)).toThrow(
      ItemObrigatorioNaoRespondidoError
    );
  });

  it("item opcional (obrigatorio=false) sem resposta -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "conforme" },
    ];
    expect(() => validarRespostasParaFinalizar([ITEM_1, ITEM_2, ITEM_OPCIONAL], respostas)).not.toThrow();
  });

  it("todos os itens obrigatórios respondidos e conformes -> não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "conforme" },
    ];
    expect(() => validarRespostasParaFinalizar([ITEM_1, ITEM_2], respostas)).not.toThrow();
  });

  it("item obrigatório respondido como não aplicável -> conta como respondido, não lança", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "nao_aplicavel" },
    ];
    expect(() => validarRespostasParaFinalizar([ITEM_1, ITEM_2], respostas)).not.toThrow();
  });

  it("também valida observação obrigatória (delega para validarObservacoesObrigatorias)", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "nao_conforme" },
    ];
    expect(() => validarRespostasParaFinalizar([ITEM_1, ITEM_2], respostas)).toThrow(ObservacaoObrigatoriaError);
  });
});

describe("calcularTodosConformes — RN-CHK-02 (critério é bloqueiaAprovacao, não obrigatorio)", () => {
  it("todos os itens impeditivos conformes -> true", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "conforme" },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(true);
  });

  it("um item impeditivo não conforme -> false (cenário misto)", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "nao_conforme", observacao: "Freio não trava corretamente." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(false);
  });

  it("item obrigatório sem resposta -> não é tratado como não conformidade", () => {
    // Completude é responsabilidade de validarRespostasParaFinalizar, que roda ANTES e
    // impede finalizar com item obrigatório em branco. Aqui só se decide se há não
    // conformidade impeditiva — e "não respondido" não é "não conforme".
    const respostas: RespostaChecklist[] = [{ itemId: "item-1", resultado: "conforme" }];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(true);
  });

  it("item impeditivo respondido como não aplicável -> não bloqueia", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "nao_aplicavel" },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(true);
  });

  it("item não impeditivo com não conformidade não bloqueia a aprovação", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-2", resultado: "conforme" },
      { itemId: "item-opcional", resultado: "nao_conforme", observacao: "Detalhe estético, sem risco." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2, ITEM_OPCIONAL], respostas)).toBe(true);
  });

  it("questão obrigatória marcada como não impeditiva: não conformidade nela libera a aprovação", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "conforme" },
      { itemId: "item-doc", resultado: "nao_conforme", observacao: "ART ainda não anexada." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_OBRIGATORIO_NAO_IMPEDITIVO], respostas)).toBe(true);
  });

  it("nenhum item impeditivo no template -> true (nada bloqueia)", () => {
    expect(calcularTodosConformes([ITEM_OPCIONAL], [])).toBe(true);
  });

  it("todos os itens impeditivos não conformes -> false", () => {
    const respostas: RespostaChecklist[] = [
      { itemId: "item-1", resultado: "nao_conforme", observacao: "Guarda-corpo solto." },
      { itemId: "item-2", resultado: "nao_conforme", observacao: "Freio não trava corretamente." },
    ];
    expect(calcularTodosConformes([ITEM_1, ITEM_2], respostas)).toBe(false);
  });
});
