import type { ResultadoItemChecklist } from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";

export interface TemplateResolvido {
  templateId: string | null;
  templateNome: string | null;
}

// ÚNICA fonte de verdade de "esta plataforma exige checklist de segurança": a configuração
// explícita do próprio equipamento (Plataforma.exige_checklist + checklist_template_id).
//
// Antes a exigência era DERIVADA da categoria: a plataforma sem template próprio herdava o
// template "padrão" da sua categoria, e só existiam templates padrão para 'elevatoria' e
// 'andaime' (as duas únicas categorias seedadas em 0006). Como o cadastro da Frota nunca
// expôs `categoria`, toda plataforma criada pela UI nascia 'outro' — resultado prático: só a
// única plataforma marcada como 'elevatoria' no banco, a "Plataforma Elevatória Demo S8",
// caía no fluxo com checklist. Não havia condição por nome/código em lugar nenhum; o efeito
// de hardcode vinha dessa herança por categoria somada à ausência de configuração na UI.
//
// Agora a regra é configurada por equipamento e vale igual para qualquer um deles. Único
// ponto de acesso a banco neste módulo — o resto do arquivo é lógica pura — porque
// routes/checklist.ts, routes/reservas.ts (gate de aprovação) e o worker de automação
// precisam da mesma resolução.
export async function resolverTemplateEfetivo(plataformaId: string): Promise<TemplateResolvido> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .query<{ id: string; nome: string }>(
      `SELECT t.id, t.nome
       FROM Plataforma p
       JOIN ChecklistTemplate t ON t.id = p.checklist_template_id AND t.ativo = 1
       WHERE p.id = @plataforma_id AND p.exige_checklist = 1`
    );
  const linha = result.recordset[0];
  return { templateId: linha?.id ?? null, templateNome: linha?.nome ?? null };
}

// Mesma regra da resolução acima, como subconsulta correlacionada — para as listagens que
// precisam do flag por linha sem pagar um round-trip por reserva. `p` é o alias da
// Plataforma no escopo onde for interpolada.
export const SQL_PLATAFORMA_EXIGE_CHECKLIST = `
  CAST(CASE WHEN EXISTS (
    SELECT 1 FROM ChecklistTemplate tpl
    WHERE tpl.id = p.checklist_template_id AND tpl.ativo = 1 AND p.exige_checklist = 1
  ) THEN 1 ELSE 0 END AS BIT)`;

export interface ItemTemplateChecklist {
  itemId: string;
  obrigatorio: boolean;
  // Uma resposta "nao_conforme" neste item impede a aprovação da reserva. Independente de
  // `obrigatorio`, que só diz se o item precisa ser respondido para finalizar.
  bloqueiaAprovacao: boolean;
}

export interface RespostaChecklist {
  itemId: string;
  resultado: ResultadoItemChecklist;
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

// RN-CHK-01: toda resposta com resultado=nao_conforme exige observacao preenchida (não em
// branco) — vale tanto para rascunho quanto para finalização, já que é uma regra por item,
// independente de o checklist estar completo.
export function validarObservacoesObrigatorias(respostas: RespostaChecklist[]): void {
  for (const resposta of respostas) {
    if (resposta.resultado === "nao_conforme" && !resposta.observacao?.trim()) {
      throw new ObservacaoObrigatoriaError(resposta.itemId);
    }
  }
}

// RF-CHK-06/RN-CHK-03: só na finalização todo item obrigatorio=1 do template precisa estar
// entre as respostas — salvar progresso (rascunho) aceita um subconjunto (ver PUT
// /reservas/:id/checklist), permitindo "8 de 12 itens preenchidos" como estado válido.
export function validarRespostasParaFinalizar(
  itensTemplate: ItemTemplateChecklist[],
  respostas: RespostaChecklist[]
): void {
  validarObservacoesObrigatorias(respostas);
  for (const item of itensTemplate) {
    if (!item.obrigatorio) continue;
    const resposta = respostas.find((r) => r.itemId === item.itemId);
    if (!resposta) {
      throw new ItemObrigatorioNaoRespondidoError(item.itemId);
    }
  }
}

// RN-CHK-02 — "não há não conformidade impeditiva". O critério passou a ser o item ter
// `bloqueiaAprovacao`, não mais ser `obrigatorio`: as duas regras eram o mesmo campo e não
// davam como expressar "esta questão precisa ser respondida, mas responder 'não conforme'
// nela não trava a aprovação" (ex.: "Documentação disponível", que gera pendência
// administrativa, não risco de segurança).
//
// "nao_aplicavel" nunca bloqueia — um item que não se aplica a esta reserva não é uma
// não conformidade. Só um `nao_conforme` explícito em item impeditivo bloqueia.
export function calcularTodosConformes(
  itensTemplate: ItemTemplateChecklist[],
  respostas: RespostaChecklist[]
): boolean {
  return itensTemplate
    .filter((item) => item.bloqueiaAprovacao)
    .every((item) => respostas.find((r) => r.itemId === item.itemId)?.resultado !== "nao_conforme");
}
