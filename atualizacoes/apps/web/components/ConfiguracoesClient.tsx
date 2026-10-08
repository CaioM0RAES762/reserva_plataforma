"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import styles from "./Admin.module.css";
import local from "./ConfiguracoesClient.module.css";
import { LIMITES_CONFIGURACAO, type CampoNumericoConfiguracao } from "@plataformares/shared";
import { ApiRequestError, apiFetch } from "../lib/api";
import { CategoriasEquipamentoSecao } from "./CategoriasEquipamentoSecao";
import { ResponsaveisPlataformaSecao } from "./ResponsaveisPlataformaSecao";

interface Configuracao {
  chave: string;
  valor: string;
  descricao: string | null;
  atualizadoEm: string;
  atualizadoPorId: string | null;
}

interface CampoConfig {
  chave: string;
  campoApi: string;
  label: string;
  /** Uma linha, em linguagem de quem usa o sistema — os códigos RN/RF ficam na documentação. */
  ajuda: string;
  tipo: "numero" | "hora";
  sufixo?: string;
}

// A `descricao` gravada no banco carrega códigos de requisito (RN-RES-03, RF-CFG-01...) e
// continua lá para documentação/auditoria; a tela usa estes textos curtos.
const REGRAS: CampoConfig[] = [
  {
    chave: "antecedencia_minima_horas",
    campoApi: "antecedenciaMinimaHoras",
    label: "Antecedência mínima",
    ajuda: "Tempo mínimo antes do início da reserva.",
    tipo: "numero",
    sufixo: "h",
  },
  {
    chave: "duracao_maxima_horas",
    campoApi: "duracaoMaximaHoras",
    label: "Duração máxima",
    ajuda: "Tempo máximo de uma reserva.",
    tipo: "numero",
    sufixo: "h",
  },
  {
    chave: "max_pendentes_por_setor",
    campoApi: "maxPendentesPorSetor",
    label: "Máx. reservas pendentes",
    ajuda: "Por setor, ao mesmo tempo.",
    tipo: "numero",
  },
  {
    chave: "sla_aprovacao_urgente_horas",
    campoApi: "slaAprovacaoUrgenteHoras",
    label: "SLA de urgência",
    ajuda: "Prazo para decidir uma reserva urgente.",
    tipo: "numero",
    sufixo: "h",
  },
];

const CHAVE_INICIO = "horario_expediente_inicio";
const CHAVE_FIM = "horario_expediente_fim";

const HORARIO: CampoConfig[] = [
  { chave: CHAVE_INICIO, campoApi: "horarioExpedienteInicio", label: "Início", ajuda: "", tipo: "hora" },
  { chave: CHAVE_FIM, campoApi: "horarioExpedienteFim", label: "Fim", ajuda: "", tipo: "hora" },
];

const CAMPOS: CampoConfig[] = [...REGRAS, ...HORARIO];

// Política de aprovação (migration 0023).
const CHAVE_MODO_APROVACAO = "modo_aprovacao_reservas";
const MODOS_APROVACAO: Array<{ valor: "manual" | "automatica"; titulo: string; descricao: string }> = [
  { valor: "manual", titulo: "Manual", descricao: "Reservas ficam pendentes até a aprovação." },
  { valor: "automatica", titulo: "Automática", descricao: "Reservas válidas são aprovadas imediatamente." },
];

// Política de substituição por urgência (migration 0030).
const CHAVE_POLITICA_SUBSTITUICAO = "politica_substituicao_reserva_urgente";
const POLITICAS_SUBSTITUICAO: Array<{
  valor: "todos_aprovadores" | "responsaveis_plataforma_ou_admin";
  titulo: string;
  descricao: string;
}> = [
  {
    valor: "todos_aprovadores",
    titulo: "Todos os aprovadores",
    descricao: "Admin ou qualquer Gestor de Setor pode autorizar a substituição.",
  },
  {
    valor: "responsaveis_plataforma_ou_admin",
    titulo: "Somente Admin ou responsáveis",
    descricao: "Só o Admin ou um gestor atribuído como responsável pela plataforma. Sem responsável, só o Admin.",
  },
];

const TODAS_AS_CHAVES = [...CAMPOS.map((c) => c.chave), CHAVE_MODO_APROVACAO, CHAVE_POLITICA_SUBSTITUICAO];
const CHAVE_POR_CAMPO_API: Record<string, string> = Object.fromEntries(CAMPOS.map((c) => [c.campoApi, c.chave]));
const ROTULO_POR_CHAVE: Record<string, string> = Object.fromEntries(CAMPOS.map((c) => [c.chave, c.label]));

// Mesmas faixas que a API valida (pacote compartilhado): a tela avisa antes de enviar e a
// mensagem diz qual é o intervalo, em vez de um genérico "fora do intervalo".
function limitesDoCampo(campoApi: string): { min: number; max: number } | null {
  return campoApi in LIMITES_CONFIGURACAO ? LIMITES_CONFIGURACAO[campoApi as CampoNumericoConfiguracao] : null;
}

function mensagemForaDoLimite(campo: CampoConfig): string {
  const limites = limitesDoCampo(campo.campoApi);
  const unidade = campo.sufixo ? ` ${campo.sufixo}` : "";
  return limites
    ? `${campo.label}: use um número inteiro entre ${limites.min} e ${limites.max}${unidade}.`
    : `${campo.label}: valor inválido.`;
}

function validarNumeros(valores: Record<string, string>): { mensagem: string; chaves: string[] } | null {
  const mensagens: string[] = [];
  const chaves: string[] = [];
  for (const campo of REGRAS) {
    const limites = limitesDoCampo(campo.campoApi);
    const bruto = (valores[campo.chave] ?? "").trim();
    const numero = Number(bruto);
    if (!bruto || !Number.isInteger(numero) || (limites && (numero < limites.min || numero > limites.max))) {
      mensagens.push(mensagemForaDoLimite(campo));
      chaves.push(campo.chave);
    }
  }
  return mensagens.length > 0 ? { mensagem: mensagens.join(" "), chaves } : null;
}

// Quanto tempo o "✓ Alterações salvas" fica visível.
const FEEDBACK_SALVO_MS = 4000;

// O expediente é a fonte da grade do Calendário e dos horários da Nova Reserva: um par
// invertido/vazio não pode nem chegar ao servidor. A mesma regra existe no backend
// (atualizarConfiguracoesSchema); validar aqui só evita a viagem e dá a mensagem no ponto certo.
function validarExpediente(valores: Record<string, string>): { mensagem: string; chaves: string[] } | null {
  const inicio = valores[CHAVE_INICIO] ?? "";
  const fim = valores[CHAVE_FIM] ?? "";
  if (!inicio || !fim) {
    return {
      mensagem: "Informe o início e o fim do horário de funcionamento.",
      chaves: [!inicio ? CHAVE_INICIO : null, !fim ? CHAVE_FIM : null].filter((c): c is string => c !== null),
    };
  }
  // "HH:mm" com zero à esquerda: a ordem lexicográfica é a ordem cronológica.
  if (fim <= inicio) {
    return {
      mensagem: `O fim (${fim}) precisa ser depois do início (${inicio}). Para o dia inteiro, use 00:00 e 23:59.`,
      chaves: [CHAVE_FIM],
    };
  }
  return null;
}

// 422 de PUT /configuracoes: `detalhes` é o `flatten()` do Zod ({ formErrors, fieldErrors }).
// Só as mensagens dos campos de horário são escritas em português pelo backend; as demais
// (limites numéricos) vêm no idioma padrão do Zod, então mostramos o rótulo do campo com um
// texto nosso em vez de despejar inglês na tela.
function interpretarValidacao(detalhes: unknown): { mensagens: string[]; chaves: string[] } {
  const mensagens: string[] = [];
  const chaves: string[] = [];
  if (!detalhes || typeof detalhes !== "object") return { mensagens, chaves };
  const { formErrors, fieldErrors } = detalhes as { formErrors?: unknown; fieldErrors?: unknown };
  if (Array.isArray(formErrors)) {
    for (const m of formErrors) if (typeof m === "string") mensagens.push(m);
  }
  if (fieldErrors && typeof fieldErrors === "object") {
    for (const [campoApi, lista] of Object.entries(fieldErrors as Record<string, unknown>)) {
      const chave = CHAVE_POR_CAMPO_API[campoApi];
      if (chave) chaves.push(chave);
      const primeira = Array.isArray(lista) ? lista.find((m): m is string => typeof m === "string") : undefined;
      if ((chave === CHAVE_INICIO || chave === CHAVE_FIM) && primeira) {
        mensagens.push(primeira);
      } else {
        const campo = CAMPOS.find((c) => c.campoApi === campoApi);
        mensagens.push(campo ? mensagemForaDoLimite(campo) : `${(chave && ROTULO_POR_CHAVE[chave]) ?? campoApi}: valor inválido.`);
      }
    }
  }
  return { mensagens, chaves };
}

function formatarUltimaAlteracao(iso: string): string {
  const data = new Date(iso);
  const dia = data.toLocaleDateString("pt-BR");
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${dia} às ${hora}`;
}

export function ConfiguracoesClient() {
  const [configuracoes, setConfiguracoes] = useState<Record<string, Configuracao>>({});
  const [valores, setValores] = useState<Record<string, string>>({});
  // Valores como vieram do servidor: é contra eles que se decide se há algo a salvar.
  const [originais, setOriginais] = useState<Record<string, string>>({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvoAgora, setSalvoAgora] = useState(false);
  // Chaves cujo valor foi recusado (cliente ou 422): marcam o campo com aria-invalid.
  const [chavesInvalidas, setChavesInvalidas] = useState<string[]>([]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await apiFetch<Configuracao[]>("/api/v1/configuracoes");
      const mapa: Record<string, Configuracao> = {};
      const valoresIniciais: Record<string, string> = {};
      for (const item of dados) {
        mapa[item.chave] = item;
        valoresIniciais[item.chave] = item.valor;
      }
      setConfiguracoes(mapa);
      setValores(valoresIniciais);
      setOriginais(valoresIniciais);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar configurações.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Feedback de salvamento discreto e temporário (sem faixa permanente).
  useEffect(() => {
    if (!salvoAgora) return;
    const timer = setTimeout(() => setSalvoAgora(false), FEEDBACK_SALVO_MS);
    return () => clearTimeout(timer);
  }, [salvoAgora]);

  const alterado = TODAS_AS_CHAVES.some((chave) => (valores[chave] ?? "") !== (originais[chave] ?? ""));

  // "Última alteração" UMA vez, no rodapé: a mais recente entre todas as chaves.
  const ultimaAlteracao = useMemo(() => {
    const datas = Object.values(configuracoes).map((c) => c.atualizadoEm).filter(Boolean);
    if (datas.length === 0) return null;
    return datas.reduce((maior, atual) => (new Date(atual) > new Date(maior) ? atual : maior));
  }, [configuracoes]);

  function mudarValor(chave: string, valor: string) {
    setValores((atual) => ({ ...atual, [chave]: valor }));
    setChavesInvalidas((atual) => atual.filter((c) => c !== chave));
    setSalvoAgora(false);
  }

  async function handleSalvar() {
    setErro(null);
    setSalvoAgora(false);
    setChavesInvalidas([]);

    const problema = validarNumeros(valores) ?? validarExpediente(valores);
    if (problema) {
      setErro(problema.mensagem);
      setChavesInvalidas(problema.chaves);
      return;
    }

    setSalvando(true);
    try {
      const corpo: Record<string, number | string> = {};
      for (const campo of CAMPOS) {
        const valor = valores[campo.chave];
        if (valor === undefined) continue;
        corpo[campo.campoApi] = campo.tipo === "numero" ? Number(valor) : valor;
      }
      const modo = valores[CHAVE_MODO_APROVACAO];
      if (modo === "manual" || modo === "automatica") corpo.modoAprovacaoReservas = modo;
      const politica = valores[CHAVE_POLITICA_SUBSTITUICAO];
      if (politica === "todos_aprovadores" || politica === "responsaveis_plataforma_ou_admin") {
        corpo.politicaSubstituicaoReservaUrgente = politica;
      }
      await apiFetch("/api/v1/configuracoes", {
        method: "PUT",
        body: JSON.stringify(corpo),
      });
      // O backend publica `configuracao.atualizada` (SSE): Calendário e Nova Reserva abertos
      // revalidam sozinhos — não há nada a reiniciar.
      await carregar();
      setSalvoAgora(true);
    } catch (err) {
      if (err instanceof ApiRequestError && err.ehValidacao) {
        const { mensagens, chaves } = interpretarValidacao(err.detalhes);
        setChavesInvalidas(chaves);
        setErro(mensagens.length > 0 ? mensagens.join(" ") : err.message);
      } else {
        setErro(err instanceof Error ? err.message : "Erro ao salvar configurações.");
      }
    } finally {
      setSalvando(false);
    }
  }

  function renderCampo(campo: CampoConfig) {
    const invalido = chavesInvalidas.includes(campo.chave);
    const id = `cfg-${campo.chave}`;
    return (
      <div key={campo.chave} className={local.campo}>
        <label htmlFor={id} className={local.rotulo}>
          {campo.label}
        </label>
        {campo.ajuda && <span className={local.ajuda}>{campo.ajuda}</span>}
        <div className={local.controle}>
          <input
            id={id}
            type={campo.tipo === "numero" ? "number" : "time"}
            min={campo.tipo === "numero" ? (limitesDoCampo(campo.campoApi)?.min ?? 0) : undefined}
            max={campo.tipo === "numero" ? limitesDoCampo(campo.campoApi)?.max : undefined}
            step={campo.tipo === "numero" ? 1 : undefined}
            className={`${local.input} ${invalido ? local.inputInvalido : ""}`}
            value={valores[campo.chave] ?? ""}
            aria-invalid={invalido || undefined}
            aria-describedby={invalido && erro ? "cfg-erro" : undefined}
            onChange={(e) => mudarValor(campo.chave, e.target.value)}
          />
          {campo.sufixo && <span className={local.sufixo}>{campo.sufixo}</span>}
        </div>
      </div>
    );
  }

  const modoAtual = valores[CHAVE_MODO_APROVACAO] ?? "manual";
  const politicaAtual = valores[CHAVE_POLITICA_SUBSTITUICAO] ?? "todos_aprovadores";

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Configurações</h1>
          <p>Defina as regras de funcionamento das reservas.</p>
        </div>
        <div className={local.acoes}>
          {salvoAgora && (
            <span className={local.salvo} role="status">
              <Check size={15} strokeWidth={2} aria-hidden="true" /> Alterações salvas
            </span>
          )}
          <button
            className={styles.btnPrimary}
            onClick={handleSalvar}
            disabled={salvando || carregando || !alterado}
            title={!alterado && !carregando ? "Nenhuma alteração para salvar" : undefined}
          >
            {salvando ? "Salvando..." : "Salvar alterações"}
          </button>
        </div>
      </div>

      {erro && (
        <div id="cfg-erro" className={styles.error} role="alert">
          {erro}
        </div>
      )}

      {carregando ? (
        <div className={styles.empty}>Carregando...</div>
      ) : (
        <div className={local.superficie}>
          <section className={local.secao} aria-labelledby="cfg-secao-aprovacao">
            <h2 id="cfg-secao-aprovacao" className={local.secaoTitulo}>
              Aprovação de reservas
            </h2>
            <p className={local.secaoTexto}>Como as novas reservas devem ser aprovadas?</p>
            <div className={local.opcoes} role="radiogroup" aria-labelledby="cfg-secao-aprovacao">
              {MODOS_APROVACAO.map((modo) => {
                const selecionado = modoAtual === modo.valor;
                return (
                  <label key={modo.valor} className={`${local.opcao} ${selecionado ? local.opcaoAtiva : ""}`}>
                    <input
                      type="radio"
                      name="modo-aprovacao"
                      value={modo.valor}
                      checked={selecionado}
                      onChange={() => mudarValor(CHAVE_MODO_APROVACAO, modo.valor)}
                    />
                    <span className={local.opcaoTexto}>
                      <strong>{modo.titulo}</strong>
                      <span>{modo.descricao}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className={local.nota}>Reservas urgentes com conflito sempre exigem decisão manual.</p>
          </section>

          <section className={local.secao} aria-labelledby="cfg-secao-substituicao">
            <h2 id="cfg-secao-substituicao" className={local.secaoTitulo}>
              Substituição por reserva urgente
            </h2>
            <p className={local.secaoTexto}>
              Quem pode autorizar a substituição de uma reserva existente por uma solicitação urgente?
            </p>
            <div className={local.opcoes} role="radiogroup" aria-labelledby="cfg-secao-substituicao">
              {POLITICAS_SUBSTITUICAO.map((opcao) => {
                const selecionado = politicaAtual === opcao.valor;
                return (
                  <label key={opcao.valor} className={`${local.opcao} ${selecionado ? local.opcaoAtiva : ""}`}>
                    <input
                      type="radio"
                      name="politica-substituicao"
                      value={opcao.valor}
                      checked={selecionado}
                      data-testid={`cfg-politica-${opcao.valor}`}
                      onChange={() => mudarValor(CHAVE_POLITICA_SUBSTITUICAO, opcao.valor)}
                    />
                    <span className={local.opcaoTexto}>
                      <strong>{opcao.titulo}</strong>
                      <span>{opcao.descricao}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className={local.nota}>
              Vale só para substituir reservas em conflito. Aprovar reservas sem conflito não muda. Interromper uma
              reserva em uso continua exigindo confirmação.
            </p>
          </section>

          <section className={local.secao} aria-labelledby="cfg-secao-regras">
            <h2 id="cfg-secao-regras" className={local.secaoTitulo}>
              Regras de reserva
            </h2>
            <div className={local.grade}>{REGRAS.map(renderCampo)}</div>
          </section>

          <section className={local.secao} aria-labelledby="cfg-secao-horario">
            <h2 id="cfg-secao-horario" className={local.secaoTitulo}>
              Horário de funcionamento
            </h2>
            <div className={local.grade}>{HORARIO.map(renderCampo)}</div>
            <p className={local.nota}>Para o dia inteiro, use 00:00 e 23:59.</p>
          </section>

          {ultimaAlteracao && (
            <p className={local.rodape}>Última alteração: {formatarUltimaAlteracao(ultimaAlteracao)}</p>
          )}
        </div>
      )}

      <CategoriasEquipamentoSecao />
      <ResponsaveisPlataformaSecao />
    </section>
  );
}
