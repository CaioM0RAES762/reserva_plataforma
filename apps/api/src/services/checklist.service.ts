import type { CategoriaPlataforma } from "@plataformares/shared";

// RN-RES-12/RF-RES-10: requer_checklist é derivado da categoria da plataforma, nunca
// uma coluna própria (SDD §4.2 já reserva essa semântica) — sem exceção configurável
// pelo Admin (SDD §2.2). Categoria "veiculo"/"outro" são "opcional (configurável)" no
// SDD §2.4, mas essa configuração fica fora do escopo desta sprint (S8 cobre apenas o
// obrigatório sem exceção: elevatoria/andaime); ver Pendências no relatório da sprint.
export function requerChecklist(categoria: CategoriaPlataforma): boolean {
  return categoria === "elevatoria" || categoria === "andaime";
}

export interface ItemTemplateChecklist {
  itemId: string;
  obrigatorio: boolean;
}

export interface RespostaChecklist {
  itemId: string;
  conforme: boolean;
  observacao?: string | null;
}

export class ItemObrigatorioNaoRespondidoError extends Error {
  constructor(public readonly itemId: string) {
    super(`Item obrigatório do checklist (${itemId}) não foi respondido.`);
    this.name = "ItemObrigatorioNaoRespondidoError";
  }
}

export class ObservacaoObrigatoriaError extends Error {
  constructor(public readonly itemId: string) {
    super(`Item não conforme (${itemId}) exige observação preenchida.`);
    this.name = "ObservacaoObrigatoriaError";
  }
}

// RN-CHK-01: todo item obrigatorio=1 do template deve estar entre as respostas; toda
// resposta com conforme=false exige observacao preenchida (não em branco).
export function validarRespostasChecklist(
  itensTemplate: ItemTemplateChecklist[],
  respostas: RespostaChecklist[]
): void {
  for (const item of itensTemplate) {
    if (!item.obrigatorio) continue;
    const resposta = respostas.find((r) => r.itemId === item.itemId);
    if (!resposta) {
      throw new ItemObrigatorioNaoRespondidoError(item.itemId);
    }
  }

  for (const resposta of respostas) {
    if (!resposta.conforme && !resposta.observacao?.trim()) {
      throw new ObservacaoObrigatoriaError(resposta.itemId);
    }
  }
}

// RN-CHK-02: todos_conformes = 1 somente se toda resposta de item obrigatório for
// conforme = true. Itens opcionais (obrigatorio=0) não entram no cálculo.
export function calcularTodosConformes(
  itensTemplate: ItemTemplateChecklist[],
  respostas: RespostaChecklist[]
): boolean {
  const obrigatorios = itensTemplate.filter((item) => item.obrigatorio);
  if (obrigatorios.length === 0) return true;
  return obrigatorios.every((item) => {
    const resposta = respostas.find((r) => r.itemId === item.itemId);
    return resposta?.conforme === true;
  });
}
