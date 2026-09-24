/* Formatadores de auditoria — traduzem o log bruto para frases em português.
 *
 * Regra que organiza o arquivo inteiro: eventos com semântica conhecida viram FRASE
 * (uma transição "de → para", ou um resumo pronto). Só o que não tem tratamento
 * semântico cai no caminho genérico rótulo/valor — e mesmo ali passa pelos catálogos,
 * para que nenhuma chave camelCase e nenhum enum do banco chegue à tela.
 *
 * Nada aqui altera o dado gravado. É estritamente uma camada de leitura.
 */

import {
  CAMPOS_AUDITORIA,
  EVENTOS_AUDITORIA,
  EVENTO_DESCONHECIDO,
  RECURSOS_AUDITORIA,
  VALORES_AUDITORIA,
  type AuditoriaEventoMeta,
} from "./catalogo.js";

export type { AuditoriaEventoMeta };

/** Payload de um registro: JSON solto, string crua ou ausente (ver interpretarDetalhes na API). */
export type DetalhesAuditoria = Record<string, unknown> | string | null | undefined;

export interface ContextoAuditoria {
  /** Entidade do registro ("Reserva", "Plataforma"...) — decide a família de status. */
  entidade?: string;
}

/**
 * Alteração destilada de um evento. `de`/`para` existem quando houve transição de estado
 * — a UI desenha a seta e pode empilhar verticalmente no detalhe. `resumo` é a frase
 * única para tudo o mais.
 */
export interface AlteracaoAuditoria {
  de?: string;
  para?: string;
  resumo?: string;
}

export interface CampoDetalhe {
  rotulo: string;
  valor: string;
}

// ---------------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------------

/**
 * Fallback para código ainda não catalogado: `alguma_nova_acao` → "Alguma nova acao".
 * Não é tradução — não há como inferir acentuação nem o tempo verbal certo. Existe só
 * para a tela nunca exibir snake_case cru; o código original continua no bloco técnico,
 * e a entrada de verdade deve ser adicionada ao catálogo.
 */
function humanizarCodigo(acao: string): string {
  const texto = acao.replace(/_/g, " ").trim();
  if (!texto) return EVENTO_DESCONHECIDO.titulo;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Registrado uma vez por código, para não poluir o console a cada linha renderizada. */
const desconhecidosJaAvisados = new Set<string>();

/**
 * Metadados de apresentação de um evento. Nunca lança e nunca devolve o código cru como
 * título: um evento novo criado no backend aparece como frase aproximada + "Evento do
 * sistema", e o código exato fica nos detalhes técnicos.
 */
export function traduzirAcao(acao: string): AuditoriaEventoMeta {
  const meta = EVENTOS_AUDITORIA[acao];
  if (meta) return meta;

  // Em desenvolvimento, avisa que falta uma entrada no catálogo — é assim que a tradução
  // acompanha o backend sem depender de alguém lembrar de conferir a tela.
  // Lido via globalThis porque `shared` roda nos dois lados e não declara @types/node:
  // no navegador `process` simplesmente não existe.
  const ambiente = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NODE_ENV;
  if (!desconhecidosJaAvisados.has(acao) && ambiente === "development") {
    desconhecidosJaAvisados.add(acao);
    console.warn(
      `[auditoria] Evento "${acao}" não está em EVENTOS_AUDITORIA — exibido com fallback. ` +
        "Adicione-o em packages/shared/src/auditoria/catalogo.ts."
    );
  }

  return { ...EVENTO_DESCONHECIDO, titulo: humanizarCodigo(acao) };
}

/** Nome do tipo de recurso ("Reserva", "Usuário"), nunca o nome da entidade de backend. */
export function traduzirRecurso(entidade: string | null | undefined): string {
  if (!entidade) return "Sistema";
  return RECURSOS_AUDITORIA[entidade] ?? humanizarCodigo(entidade);
}

/** Valor enumerado → rótulo humano. Sem correspondência, devolve o próprio valor. */
export function traduzirValor(familia: string, valor: unknown): string {
  const bruto = String(valor ?? "");
  return VALORES_AUDITORIA[familia]?.[bruto] ?? bruto;
}

export function traduzirCampo(chave: string): string {
  return CAMPOS_AUDITORIA[chave] ?? humanizarCodigo(chave);
}

/** "Reserva" e "Plataforma" usam o mesmo par de chaves com domínios de status diferentes. */
function familiaDeStatus(entidade: string | undefined): string {
  return entidade === "Plataforma" ? "statusPlataforma" : "statusReserva";
}

// ---------------------------------------------------------------------------------
// Alteração (coluna principal da listagem)
// ---------------------------------------------------------------------------------

function objeto(detalhes: DetalhesAuditoria): Record<string, unknown> | null {
  if (!detalhes || typeof detalhes === "string") return null;
  return detalhes;
}

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === "") return null;
  return String(valor);
}

/**
 * O coração da tradução: dado o evento e o payload, devolve o que mudou em português.
 *
 * A ordem dos casos importa — os específicos (checklist, SLA, ativação) vêm antes do
 * caso genérico de transição de status, porque vários deles também carregam
 * statusAnterior/statusNovo e mereceriam uma frase melhor que "Pendente → Agendada".
 */
export function formatarDetalhesAuditoria(
  acao: string,
  detalhes: DetalhesAuditoria,
  contexto: ContextoAuditoria = {}
): AlteracaoAuditoria {
  const d = objeto(detalhes);

  // Payload que não é JSON (fallback de linha corrompida): mostra o texto, não o some.
  if (!d) {
    return typeof detalhes === "string" && detalhes.trim() ? { resumo: detalhes.trim() } : {};
  }

  // --- Checklist: finalizado x rascunho, conforme x com pendências -----------------
  if (acao === "finalizar_checklist" || acao === "salvar_rascunho_checklist") {
    const total = Number(d.totalRespostas ?? 0);
    const um = total === 1;
    const itens = `${total} ${um ? "item" : "itens"}`;
    if (acao === "salvar_rascunho_checklist") {
      return { resumo: `Preenchimento parcial · ${itens} ${um ? "respondido" : "respondidos"}` };
    }
    return d.todosConformes === true
      ? { resumo: `Checklist finalizado · ${itens} ${um ? "conforme" : "conformes"}` }
      : { resumo: `Checklist finalizado com pendências · ${itens} ${um ? "avaliado" : "avaliados"}` };
  }

  // --- SLA: o número sozinho não diz nada; a frase diz o que aconteceu -------------
  if (acao === "escalonar_sla_urgente") {
    const horas = Number(d.slaHoras ?? 0);
    return { resumo: `SLA de ${horas} ${horas === 1 ? "hora" : "horas"} excedido` };
  }

  // --- Ativação/desativação: booleano vira o efeito, não "true → false" ------------
  if (typeof d.ativoNovo === "boolean") {
    const alvo = contexto.entidade === "Setor" ? "Setor" : "Usuário";
    return { resumo: d.ativoNovo ? `${alvo} ativado` : `${alvo} desativado` };
  }

  // --- Perfil de acesso ------------------------------------------------------------
  if (d.perfilAnterior || d.perfilNovo) {
    return {
      de: traduzirValor("perfil", d.perfilAnterior),
      para: traduzirValor("perfil", d.perfilNovo),
    };
  }

  // --- Aprovação: quem aprovou importa mais que a transição de status --------------
  if (acao === "aprovar_reserva") {
    const familia = familiaDeStatus(contexto.entidade);
    const de = texto(d.statusAnterior);
    const para = texto(d.statusNovo);
    if (de && para) {
      return { de: traduzirValor(familia, de), para: traduzirValor(familia, para) };
    }
    const perfil = texto(d.perfilAprovador);
    return perfil ? { resumo: `Aprovado por ${traduzirValor("perfil", perfil)}` } : {};
  }

  // --- Substituição por urgência: o motivo já nomeia a reserva urgente ----------------
  if (acao === "substituir_reserva") {
    const motivo = texto(d.motivo);
    const minutos = typeof d.usoContabilizadoMinutos === "number" ? d.usoContabilizadoMinutos : null;
    const partes: string[] = [];
    if (motivo) partes.push(motivo);
    if (d.estavaEmUso === true) partes.push(`uso interrompido${minutos !== null ? ` após ${minutos} min` : ""}`);
    return partes.length ? { resumo: partes.join(" · ") } : {};
  }

  // --- Modo de aprovação de reservas -------------------------------------------------
  if (acao === "alterar_modo_aprovacao") {
    const rotulo = (v: unknown) => (v === "automatica" ? "Automática" : v === "manual" ? "Manual" : "—");
    return { de: rotulo(d.modoAnterior), para: rotulo(d.modoNovo) };
  }

  // --- Correção manual do horímetro -------------------------------------------------
  if (acao === "corrigir_horimetro") {
    const anterior = typeof d.horimetroAnteriorHoras === "number" ? d.horimetroAnteriorHoras : null;
    const novo = typeof d.horimetroNovoHoras === "number" ? d.horimetroNovoHoras : null;
    return {
      de: anterior === null ? "—" : `${anterior} h`,
      para: novo === null ? "—" : `${novo} h`,
    };
  }

  // --- Rejeição: o motivo é a informação, não o status ----------------------------
  if (acao === "rejeitar_reserva") {
    const motivo = texto(d.motivo);
    return motivo ? { resumo: `Motivo: ${motivo}` } : { resumo: "Reserva rejeitada" };
  }

  // --- Criação de reserva: a janela reservada é o dado útil ------------------------
  // Fica ANTES da transição genérica de propósito: o backend grava `statusNovo: "agendada"`
  // neste evento (sem statusAnterior), e a transição genérica o mostraria como "— → Agendada"
  // — o que não diz nada de útil e escondia a janela reservada.
  if (acao === "criar_reserva") {
    const data = texto(d.data);
    const inicio = texto(d.horaInicio);
    const fim = texto(d.horaFim);
    const partes: string[] = [];
    if (data) partes.push(formatarDataCurtaIso(data));
    if (inicio && fim) partes.push(`${inicio}–${fim}`);
    const prioridade = texto(d.prioridade);
    if (prioridade && prioridade !== "normal") {
      partes.push(`prioridade ${traduzirValor("prioridade", prioridade).toLowerCase()}`);
    }
    if (partes.length) return { resumo: partes.join(" · ") };
    // Payload sem janela (registro incompleto): cai para a transição de status abaixo,
    // que ao menos mostra o estado em que a reserva nasceu.
  }

  // --- Transição de status genérica ------------------------------------------------
  if (d.statusAnterior || d.statusNovo) {
    const familia = familiaDeStatus(contexto.entidade);
    return {
      de: traduzirValor(familia, d.statusAnterior),
      para: traduzirValor(familia, d.statusNovo),
    };
  }

  // --- Ocorrência ------------------------------------------------------------------
  if (acao === "reportar_ocorrencia") {
    const gravidade = texto(d.gravidade);
    const partes: string[] = [];
    if (gravidade) partes.push(`Gravidade ${traduzirValor("gravidade", gravidade).toLowerCase()}`);
    if (d.geraManutencao === true) partes.push("plataforma enviada para manutenção");
    return partes.length ? { resumo: partes.join(" · ") } : {};
  }

  // --- Bloqueio de agenda ----------------------------------------------------------
  if (acao === "criar_bloqueio") {
    const motivo = texto(d.motivo);
    const conflito = d.confirmadoComReservasConflitantes === true;
    const partes: string[] = [];
    if (motivo) partes.push(motivo);
    if (conflito) partes.push("sobre reservas existentes");
    return partes.length ? { resumo: partes.join(" · ") } : {};
  }

  // --- Anexo -----------------------------------------------------------------------
  if (acao === "anexar_arquivo") {
    const nome = texto(d.nomeArquivo);
    return nome ? { resumo: nome } : {};
  }

  // --- Configurações: quantos parâmetros mudaram, não o dump do objeto -------------
  if (acao === "atualizar_configuracao") {
    const chaves = Object.keys(d);
    if (chaves.length === 0) return {};
    return {
      resumo: `${chaves.length} ${chaves.length === 1 ? "parâmetro alterado" : "parâmetros alterados"}`,
    };
  }

  // --- Cadastro de usuário / plataforma / setor: identidade do que foi criado ------
  const nome = texto(d.nome);
  if (nome) {
    const codigo = texto(d.codigo);
    return { resumo: codigo ? `${nome} · ${codigo}` : nome };
  }

  return {};
}

/** "2026-08-14" → "14 ago". Sem `Date` para não escorregar de fuso num dia puro. */
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function formatarDataCurtaIso(iso: string): string {
  const partes = iso.slice(0, 10).split("-");
  if (partes.length !== 3) return iso;
  const mes = Number(partes[1]);
  if (!mes || mes < 1 || mes > 12) return iso;
  return `${partes[2]} ${MESES_CURTOS[mes - 1]}`;
}

/** Versão em texto plano da alteração — usada pelo CSV e por `title`/aria-label. */
export function alteracaoEmTexto(alteracao: AlteracaoAuditoria): string {
  if (alteracao.de || alteracao.para) {
    return `${alteracao.de || "—"} → ${alteracao.para || "—"}`;
  }
  return alteracao.resumo ?? "";
}

// ---------------------------------------------------------------------------------
// Detalhe expandido
// ---------------------------------------------------------------------------------

/** Chaves que já viraram frase, coluna própria ou identificação do recurso. */
const CHAVES_JA_APRESENTADAS = new Set([
  "statusAnterior",
  "statusNovo",
  "ativoAnterior",
  "ativoNovo",
  "perfilAnterior",
  "perfilNovo",
  "todosConformes",
  "totalRespostas",
  "finalizar",
  "slaHoras",
  "plataformaId",
  "reservaId",
  "ocorrenciaId",
  "recorrenciaId",
  "templateId",
  "checklistTemplateId",
  "setorId",
]);

const FAMILIA_POR_CHAVE: Record<string, string> = {
  perfil: "perfil",
  perfilAprovador: "perfil",
  prioridade: "prioridade",
  gravidade: "gravidade",
  categoriaPlataforma: "categoriaPlataforma",
  origem: "origem",
  campo: "campo",
};

function valorLegivel(chave: string, valor: unknown): string {
  if (valor === null || valor === undefined) return "—";
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  const familia = FAMILIA_POR_CHAVE[chave];
  if (familia) return traduzirValor(familia, valor);
  if (chave === "tamanhoBytes") {
    const bytes = Number(valor);
    if (Number.isFinite(bytes)) {
      return bytes >= 1_048_576
        ? `${(bytes / 1_048_576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }
  }
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor);
}

/**
 * Campos restantes do payload, já rotulados, para o detalhe expandido. Exclui o que a
 * frase de alteração e a identificação do recurso já disseram — repetir "Novo status:
 * Disponível" logo abaixo de "Em manutenção → Disponível" é ruído, não rastreabilidade.
 */
export function detalhesComplementares(detalhes: DetalhesAuditoria): CampoDetalhe[] {
  const d = objeto(detalhes);
  if (!d) return [];
  return Object.entries(d)
    .filter(([chave, valor]) => !CHAVES_JA_APRESENTADAS.has(chave) && valor !== null && valor !== undefined && valor !== "")
    .map(([chave, valor]) => ({ rotulo: traduzirCampo(chave), valor: valorLegivel(chave, valor) }));
}
