"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Ban,
  CalendarClock,
  CalendarSearch,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CirclePlay,
  Hourglass,
  OctagonX,
  PowerOff,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  MINUTOS_DIA,
  PASSO_MINUTOS_PADRAO,
  ULTIMO_MINUTO_RESERVAVEL,
  calcularIntervalosLivres,
  calcularJanelaGrade,
  fimMaximoPossivel,
  minutosParaHora,
  type DisponibilidadeDiaResposta,
  type FaixaMinutos,
  type IntervaloOcupadoDisponibilidade,
  type PlataformaDisponibilidade,
  type ProximoHorarioResposta,
  type StatusPlataforma,
} from "@plataformares/shared";
import styles from "./DisponibilidadeTimeline.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDisponibilidade } from "../lib/useDisponibilidade";
import { intervaloPertenceAoUsuario } from "../lib/disponibilidadeOwnership";

// Timeline de disponibilidade das plataformas ao longo de UM dia. Reutilizável: quem a
// hospeda só decide o que fazer com o horário escolhido (`onSelecionarHorario`) — hoje, abrir a
// "Nova reserva" já preenchida. Nenhuma reserva é criada aqui.
//
// Fonte única de dados: `useDisponibilidade(data)` (UMA consulta agregada para todas as
// plataformas do dia, revalidada por SSE). Nada de polling e nada de N requisições por
// plataforma; a única chamada extra é o "Próximo horário livre", sob demanda, por linha.

export interface SelecaoHorario {
  plataformaId: string;
  /** YYYY-MM-DD */
  data: string;
  /** Minutos desde 00:00. */
  inicioMin: number;
  /** Minutos desde 00:00 — sugestão (início + 1h ou até onde o trecho livre permitir). */
  fimMin: number;
}

export interface DisponibilidadeTimelineProps {
  /** Id da sessão atual, usado exclusivamente para identificar ownership das reservas. */
  usuarioId: string;
  /** Dia exibido inicialmente (YYYY-MM-DD). Padrão: hoje. */
  dataInicial?: string;
  onSelecionarHorario?: (selecao: SelecaoHorario) => void;
  /**
   * Recolhimento controlado por quem hospeda (que também guarda a preferência). Sem
   * `onAlternarRecolhida` o cabeçalho não ganha o controle e a seção fica sempre aberta.
   * Recolhida = não consulta a API.
   */
  recolhida?: boolean;
  onAlternarRecolhida?: () => void;
  /** false = ainda não consulta (ex.: a preferência de recolhimento está sendo lida). */
  ativo?: boolean;
  /**
   * Muda de valor sempre que o hospedeiro sabe que a disponibilidade mudou (reserva criada
   * ou cancelada nesta aba) — força uma nova consulta sem depender só do SSE.
   */
  revisao?: number;
}

// ---------------------------------------------------------------------------------------
// Constantes de domínio da tela
// ---------------------------------------------------------------------------------------

const SUGESTAO_DURACAO_MIN = 60;
/** Mesmo valor enviado à API e citado na mensagem de "nenhum horário" — nunca divergem. */
const LIMITE_DIAS_PROXIMO = 14;
const MEDIA_DESKTOP = "(min-width: 900px)";
const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_SEM_PERMISSAO = /n[ãa]o autenticado|sess[ãa]o inv[aá]lida|sem permiss[ãa]o/i;

type TipoVisual = "reservada" | "em_uso" | "pendente" | "concluida" | "bloqueio" | "bloqueio_global";

const META_TIPO: Record<TipoVisual, { rotulo: string; Icone: LucideIcon; classe: string }> = {
  reservada: { rotulo: "Reservada", Icone: CalendarClock, classe: styles.tipoReservada },
  em_uso: { rotulo: "Em uso", Icone: CirclePlay, classe: styles.tipoEmUso },
  // Solicitação aguardando aprovação: aparece (quem pediu precisa ver que o pedido existe),
  // mas NÃO ocupa horário — tracejado, e fora do cálculo de livres (ver montarModelo).
  pendente: { rotulo: "Pendente de aprovação", Icone: Hourglass, classe: styles.tipoPendente },
  concluida: { rotulo: "Concluída", Icone: CircleCheck, classe: styles.tipoConcluida },
  bloqueio: { rotulo: "Bloqueio da plataforma", Icone: Ban, classe: styles.tipoBloqueio },
  bloqueio_global: { rotulo: "Bloqueio global", Icone: OctagonX, classe: styles.tipoBloqueioGlobal },
};

const ROTULO_STATUS_PLATAFORMA: Record<StatusPlataforma, string> = {
  disponivel: "Disponível",
  // `reservada` na plataforma significa "em uso agora" (status derivado da reserva em_uso).
  reservada: "Em uso",
  manutencao: "Em manutenção",
  inativa: "Inativa",
};

const CLASSE_CHIP_STATUS: Record<StatusPlataforma, string> = {
  disponivel: styles.chipDisponivel,
  reservada: styles.chipEmUso,
  manutencao: styles.chipManutencao,
  inativa: styles.chipInativa,
};

// ---------------------------------------------------------------------------------------
// Datas (locais — o dia exibido é o do calendário do usuário, como no restante da tela)
// ---------------------------------------------------------------------------------------

function paraISO(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function hojeISO(): string {
  return paraISO(new Date());
}

function somarDias(iso: string, dias: number): string {
  const [ano, mes, dia] = iso.split("-").map(Number);
  return paraISO(new Date(ano, mes - 1, dia + dias));
}

function diaDaSemanaCurto(iso: string): string {
  const [ano, mes, dia] = iso.split("-").map(Number);
  return new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
}

function dataCurta(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

/** "hoje, 18/09" · "amanhã, 19/09" · "sex, 20/09" · "sex, 20/09/2027" (ano só quando difere). */
function rotuloDoDia(iso: string): string {
  const hoje = hojeISO();
  const [ano] = iso.split("-").map(Number);
  let dia: string;
  if (iso === hoje) dia = "hoje";
  else if (iso === somarDias(hoje, 1)) dia = "amanhã";
  else if (iso === somarDias(hoje, -1)) dia = "ontem";
  else dia = diaDaSemanaCurto(iso);
  const data = ano === new Date().getFullYear() ? dataCurta(iso) : `${dataCurta(iso)}/${ano}`;
  return `${dia}, ${data}`;
}

function formatarFaixa(inicioMin: number, fimMin: number): string {
  return `${minutosParaHora(inicioMin)}–${minutosParaHora(fimMin)}`;
}

// ---------------------------------------------------------------------------------------
// Modelo derivado da resposta (puro — recalculado quando os dados ou o "agora" mudam)
// ---------------------------------------------------------------------------------------

interface OcupadoModelo {
  chave: string;
  tipo: TipoVisual;
  inicioMin: number;
  fimMin: number;
  faixa: string;
  /** "Ocupado 09:00–11:00 · Setor X · Reservada" — vira aria-label e title. */
  descricao: string;
  /** "Setor X · Reservada" — linha de texto do cartão mobile. */
  detalhe: string;
  propria: boolean;
  /** Reserva concluída que cobre um trecho ainda livre: não pode roubar o clique dele. */
  sobrepoeLivre: boolean;
  /** Pendente sobre reserva confirmada/bloqueio: desenhada como faixa sobreposta, para as duas
   *  coisas aparecerem ao mesmo tempo (a confirmada e a solicitação aguardando decisão). */
  pendenteSobreposta: boolean;
}

interface LinhaModelo {
  plataforma: PlataformaDisponibilidade;
  ocupados: OcupadoModelo[];
  livres: FaixaMinutos[];
}

interface Modelo {
  janela: ReturnType<typeof calcularJanelaGrade>;
  duracaoMaxMin: number;
  /** Início da janela que ainda pode receber uma reserva (passado/antecedência ficam antes). */
  naoReservavelAteMin: number;
  linhas: LinhaModelo[];
  comLivre: number;
  temPendente: boolean;
  temPropria: boolean;
}

function tipoVisualDe(intervalo: IntervaloOcupadoDisponibilidade): TipoVisual {
  if (intervalo.tipo === "bloqueio_global") return "bloqueio_global";
  if (intervalo.tipo === "bloqueio_plataforma") return "bloqueio";
  if (intervalo.status === "em_uso") return "em_uso";
  if (intervalo.status === "concluida") return "concluida";
  if (intervalo.status === "pendente") return "pendente";
  return "reservada";
}

function montarModelo(dados: DisponibilidadeDiaResposta, inicioMinimoMin: number, usuarioId: string): Modelo {
  const { regras } = dados;
  const janela = calcularJanelaGrade(regras.horarioExpedienteInicio, regras.horarioExpedienteFim);
  const duracaoMaxMin = Math.max(PASSO_MINUTOS_PADRAO, Math.round(regras.duracaoMaximaHoras * 60));

  let comLivre = 0;
  let temPendente = false;
  let temPropria = false;

  const linhas = dados.plataformas.map<LinhaModelo>((plataforma) => {
    // A API já não devolve canceladas; o filtro só protege o desenho caso um legado escape.
    const intervalos = plataforma.intervalos.filter(
      (i) => !(i.tipo === "reserva" && (i.status === "cancelada" || i.status === "rejeitada"))
    );

    // Livre = complemento do que OCUPA. Concluída é histórico e pendente é só uma solicitação
    // (a API ignora as duas nos conflitos), então nenhuma subtrai horário; e
    // `inicioMinimoMin` já embute passado + antecedência mínima.
    const ocupam = intervalos.filter(
      (i) => !(i.tipo === "reserva" && (i.status === "concluida" || i.status === "pendente"))
    );
    const livres = plataforma.indisponivel
      ? []
      : calcularIntervalosLivres(ocupam, janela, inicioMinimoMin)
          // Um trecho que começa no último minuto do dia não comporta reserva (fim máx. 23:59).
          .filter((l) => l.inicioMin < ULTIMO_MINUTO_RESERVAVEL);
    if (livres.length > 0) comLivre += 1;

    const ocupados = intervalos.map<OcupadoModelo>((i) => {
      const tipo = tipoVisualDe(i);
      const meta = META_TIPO[tipo];
      const faixa = formatarFaixa(i.inicioMin, i.fimMin);
      const propria = intervaloPertenceAoUsuario(i, usuarioId);
      if (tipo === "pendente") temPendente = true;
      if (propria) temPropria = true;
      const motivo = i.motivo?.trim() ? i.motivo.trim() : null;
      const pendente = tipo === "pendente";
      const pendenteSobreposta =
        pendente && ocupam.some((o) => i.inicioMin < o.fimMin && i.fimMin > o.inicioMin);
      const urgente = i.prioridade === "urgente";
      // Pendente: "Sua solicitação" vem primeiro (é o que o próprio solicitante procura) e o
      // estado é dito por extenso — nunca parece uma reserva confirmada.
      const partesDetalhe = (
        pendente
          ? [
              propria ? "Sua solicitação" : i.setorNome,
              meta.rotulo,
              urgente ? "Urgente" : null,
              pendenteSobreposta ? "Conflita com reserva confirmada — aguarda decisão" : null,
            ]
          : [i.setorNome, meta.rotulo, propria ? "Sua reserva" : null]
      ).filter(Boolean) as string[];
      const partesDescricao = [
        pendente ? `Solicitação ${faixa}` : `Ocupado ${faixa}`,
        ...partesDetalhe,
        motivo ? `Motivo: ${motivo}` : null,
      ].filter(Boolean) as string[];
      return {
        chave: `${i.tipo}-${i.id}`,
        tipo,
        inicioMin: i.inicioMin,
        fimMin: i.fimMin,
        faixa,
        descricao: partesDescricao.join(" · "),
        detalhe: [...partesDetalhe, motivo].filter(Boolean).join(" · "),
        propria,
        sobrepoeLivre: tipo === "concluida" && livres.some((l) => i.inicioMin < l.fimMin && i.fimMin > l.inicioMin),
        pendenteSobreposta,
      };
    });

    return { plataforma, ocupados, livres };
  });

  return {
    janela,
    duracaoMaxMin,
    naoReservavelAteMin: Math.min(inicioMinimoMin, janela.fimMin),
    linhas,
    comLivre,
    temPendente,
    temPropria,
  };
}

/** Posição/largura em % de uma faixa dentro da janela; `null` = fica toda fora da janela. */
function posicaoNaJanela(
  faixa: FaixaMinutos,
  janela: { inicioMin: number; fimMin: number }
): { left: string; width: string } | null {
  const total = janela.fimMin - janela.inicioMin;
  const inicio = Math.min(Math.max(faixa.inicioMin, janela.inicioMin), janela.fimMin);
  const fim = Math.min(Math.max(faixa.fimMin, janela.inicioMin), janela.fimMin);
  if (fim <= inicio) return null;
  return {
    left: `${((inicio - janela.inicioMin) / total) * 100}%`,
    width: `${((fim - inicio) / total) * 100}%`,
  };
}

function percentualNaJanela(minuto: number, janela: { inicioMin: number; fimMin: number }): number {
  const limitado = Math.min(Math.max(minuto, janela.inicioMin), janela.fimMin);
  return ((limitado - janela.inicioMin) / (janela.fimMin - janela.inicioMin)) * 100;
}

/**
 * Início escolhido ao clicar num trecho livre: a posição do clique encaixada em
 * PASSO_MINUTOS_PADRAO (para baixo — o clique dentro do bloco das 09:30 escolhe 09:30) e
 * mantida DENTRO do trecho. Se o encaixe cair antes do trecho (ex.: trecho começa às 13:10),
 * vale o início real do trecho — nunca um horário ocupado, passado ou fora da antecedência.
 */
function inicioPorPosicao(trecho: FaixaMinutos, fracao: number): number {
  const bruto = trecho.inicioMin + Math.min(Math.max(fracao, 0), 1) * (trecho.fimMin - trecho.inicioMin);
  const encaixado = Math.floor(bruto / PASSO_MINUTOS_PADRAO) * PASSO_MINUTOS_PADRAO;
  return Math.min(Math.max(encaixado, trecho.inicioMin), trecho.fimMin - 1);
}

function fracaoDoPonteiro(evento: { clientX: number; currentTarget: HTMLElement }): number {
  const caixa = evento.currentTarget.getBoundingClientRect();
  return caixa.width > 0 ? (evento.clientX - caixa.left) / caixa.width : 0;
}

// Layout: linhas com trilha horizontal em telas largas, cartões por plataforma no celular.
// `getServerSnapshot` = desktop: no servidor só existe o esqueleto, igual nos dois layouts.
// A função de assinatura fica no escopo do módulo: com identidade nova a cada render, o React
// cancelaria e refaria a assinatura do matchMedia em toda atualização.
function assinarLarguraDesktop(aviso: () => void): () => void {
  const consulta = window.matchMedia(MEDIA_DESKTOP);
  consulta.addEventListener("change", aviso);
  return () => consulta.removeEventListener("change", aviso);
}

function useLarguraDesktop(): boolean {
  return useSyncExternalStore(
    assinarLarguraDesktop,
    () => window.matchMedia(MEDIA_DESKTOP).matches,
    () => true
  );
}

// ---------------------------------------------------------------------------------------
// "Próximo horário livre" (uma requisição sob demanda por linha)
// ---------------------------------------------------------------------------------------

type EstadoProximo =
  | { estado: "carregando" }
  | { estado: "ok"; resposta: ProximoHorarioResposta }
  | { estado: "erro"; mensagem: string };

// ---------------------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------------------

export function DisponibilidadeTimeline({
  usuarioId,
  dataInicial,
  onSelecionarHorario,
  recolhida = false,
  onAlternarRecolhida,
  ativo = true,
  revisao = 0,
}: DisponibilidadeTimelineProps) {
  const idBase = useId();
  const idTitulo = `${idBase}-titulo`;
  const idCorpo = `${idBase}-corpo`;
  const desktop = useLarguraDesktop();

  // A data "de hoje" só é decidida no cliente, depois de montar: servidor e navegador podem
  // estar em fusos diferentes, e o título ("hoje, 18/09") divergiria entre o HTML e a
  // hidratação. Até lá o cabeçalho mostra só "Disponibilidade" e nada é consultado.
  const [data, setData] = useState<string | null>(dataInicial && REGEX_DATA.test(dataInicial) ? dataInicial : null);
  const [montado, setMontado] = useState(false);
  useEffect(() => {
    setMontado(true);
    setData((atual) => atual ?? hojeISO());
  }, []);

  const consultaAtiva = ativo && !recolhida && montado && data !== null;
  const { dados, carregando, erro, recarregar } = useDisponibilidade(data, {
    usuarioId,
    ativo: consultaAtiva,
  });

  // Só vale a resposta do dia que está na tela: ao trocar de data o hook mantém a resposta
  // anterior até a nova chegar, e mostrá-la sob o título novo enganaria.
  const doDia = dados && dados.data === data ? dados : null;

  // Hospedeiro avisou que a disponibilidade mudou (reserva criada/cancelada aqui).
  const revisaoVista = useRef(revisao);
  useEffect(() => {
    if (revisao === revisaoVista.current) return;
    revisaoVista.current = revisao;
    if (consultaAtiva) void recarregar();
  }, [revisao, consultaAtiva, recarregar]);

  // ---- "Agora" sem refetch -------------------------------------------------------------
  // `agoraMin` da API é o minuto em Brasília no instante da resposta. Soma-se o tempo
  // decorrido desde que a resposta chegou (relógio local só como cronômetro — nunca como
  // "hora do dia", que dependeria do fuso do navegador) e re-renderiza a cada minuto.
  const [instantaneo, setInstantaneo] = useState<{ dados: DisponibilidadeDiaResposta; em: number } | null>(null);
  useEffect(() => {
    if (dados) setInstantaneo({ dados, em: Date.now() });
  }, [dados]);
  const temAgora = doDia !== null && doDia.agoraMin !== null;
  const [, setPulso] = useState(0);
  useEffect(() => {
    if (!temAgora) return;
    const timer = window.setInterval(() => setPulso((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [temAgora]);

  const recebidoEm = doDia && instantaneo && instantaneo.dados === doDia ? instantaneo.em : Date.now();
  const decorridoMin = temAgora ? Math.max(0, Math.floor((Date.now() - recebidoEm) / 60_000)) : 0;
  const agoraMin = doDia && doDia.agoraMin !== null ? doDia.agoraMin + decorridoMin : null;
  const agoraVisivel = agoraMin !== null && agoraMin < MINUTOS_DIA;
  // Hoje o corte "agora + antecedência" anda junto com o relógio: sem isto, um trecho que já
  // passou continuaria clicável até a próxima revalidação. Data futura (0) e passada (1440)
  // não se movem.
  const inicioMinimoMin = doDia
    ? doDia.agoraMin !== null && doDia.inicioMinimoMin < MINUTOS_DIA
      ? Math.min(MINUTOS_DIA, doDia.inicioMinimoMin + decorridoMin)
      : doDia.inicioMinimoMin
    : 0;

  const modelo = useMemo(
    () => (doDia ? montarModelo(doDia, inicioMinimoMin, usuarioId) : null),
    [doDia, inicioMinimoMin, usuarioId]
  );

  // ---- Próximo horário livre ------------------------------------------------------------
  const [proximos, setProximos] = useState<Record<string, EstadoProximo>>({});
  const chaveProximo = (plataformaId: string) => `${data}|${plataformaId}`;

  const buscarProximo = useCallback(
    async (plataformaId: string) => {
      if (!data) return;
      const chave = `${data}|${plataformaId}`;
      setProximos((atual) => ({ ...atual, [chave]: { estado: "carregando" } }));
      try {
        const params = new URLSearchParams({
          plataformaId,
          data,
          duracaoMinutos: String(SUGESTAO_DURACAO_MIN),
          limiteDias: String(LIMITE_DIAS_PROXIMO),
        });
        const resposta = await apiFetch<ProximoHorarioResposta>(`/api/v1/disponibilidade/proximo?${params}`);
        setProximos((atual) => ({ ...atual, [chave]: { estado: "ok", resposta } }));
      } catch (err) {
        setProximos((atual) => ({
          ...atual,
          [chave]: { estado: "erro", mensagem: mensagemDeErro(err, "Não foi possível buscar o próximo horário.") },
        }));
      }
    },
    [data]
  );

  // ---- Seleção de horário ---------------------------------------------------------------
  function selecionar(linha: LinhaModelo, inicioMin: number) {
    if (!onSelecionarHorario || !modelo || !data) return;
    const fimMax = fimMaximoPossivel(inicioMin, linha.livres, modelo.duracaoMaxMin);
    if (fimMax === null) return;
    const fimMin = Math.min(inicioMin + SUGESTAO_DURACAO_MIN, fimMax);
    if (fimMin <= inicioMin) return;
    onSelecionarHorario({ plataformaId: linha.plataforma.id, data, inicioMin, fimMin });
  }

  function selecionarProximo(plataformaId: string, resposta: ProximoHorarioResposta) {
    if (!onSelecionarHorario || !resposta.encontrado || !resposta.data) return;
    if (resposta.inicioMin === null || resposta.fimMin === null) return;
    const fimMin = Math.min(resposta.fimMin, resposta.inicioMin + SUGESTAO_DURACAO_MIN, ULTIMO_MINUTO_RESERVAVEL);
    if (fimMin <= resposta.inicioMin) return;
    onSelecionarHorario({ plataformaId, data: resposta.data, inicioMin: resposta.inicioMin, fimMin });
  }

  function irPara(iso: string) {
    if (REGEX_DATA.test(iso)) setData(iso);
  }

  // Hover com mouse: mostra onde o clique vai começar (posição encaixada). Escreve direto
  // no DOM — um re-render por movimento do ponteiro seria custo à toa numa grade de linhas.
  function guiarPonteiro(evento: ReactPointerEvent<HTMLButtonElement>, trecho: FaixaMinutos) {
    if (evento.pointerType !== "mouse") return;
    const alvo = evento.currentTarget;
    const inicio = inicioPorPosicao(trecho, fracaoDoPonteiro(evento));
    const frac = (inicio - trecho.inicioMin) / (trecho.fimMin - trecho.inicioMin);
    alvo.style.setProperty("--guia", `${frac * 100}%`);
    alvo.setAttribute("data-inicio", minutosParaHora(inicio));
  }
  function soltarPonteiro(evento: ReactPointerEvent<HTMLButtonElement>) {
    evento.currentTarget.removeAttribute("data-inicio");
  }

  function aoClicarNoTrecho(evento: ReactMouseEvent<HTMLButtonElement>, linha: LinhaModelo, trecho: FaixaMinutos) {
    // Enter/Espaço geram click com detail 0 e sem posição: começa no início do trecho.
    const inicio = evento.detail === 0 ? trecho.inicioMin : inicioPorPosicao(trecho, fracaoDoPonteiro(evento));
    selecionar(linha, inicio);
  }

  // ---- Rolagem inicial (desktop): leva o "agora" para dentro da vista --------------------
  const rolagemRef = useRef<HTMLDivElement>(null);
  const rolouPara = useRef<string | null>(null);
  useEffect(() => {
    if (!desktop || !modelo || !data || rolouPara.current === data) return;
    const el = rolagemRef.current;
    if (!el) return;
    rolouPara.current = data;
    if (el.scrollWidth <= el.clientWidth) return;
    const coluna = el.querySelector<HTMLElement>("[data-coluna-plataforma]")?.offsetWidth ?? 0;
    const fracao = agoraMin !== null ? percentualNaJanela(agoraMin, modelo.janela) / 100 : 0;
    el.scrollLeft = Math.max(0, fracao * (el.scrollWidth - coluna) - (el.clientWidth - coluna) * 0.3);
  }, [desktop, modelo, data, agoraMin]);

  // ---- Estados -------------------------------------------------------------------------
  const semPermissao = !doDia && erro !== null && REGEX_SEM_PERMISSAO.test(erro);
  const carregandoInicial = consultaAtiva && !doDia && erro === null;
  const hoje = montado ? hojeISO() : null;
  const dataPassada = data !== null && hoje !== null && data < hoje;
  const titulo = montado && data ? `Disponibilidade — ${rotuloDoDia(data)}` : "Disponibilidade";

  const resumo =
    modelo && modelo.linhas.length > 0
    ? `${modelo.comLivre} de ${modelo.linhas.length} ${modelo.linhas.length === 1 ? "plataforma" : "plataformas"} com horário livre`
    : null;

  // ---- Peças de renderização -----------------------------------------------------------
  function chipStatus(plataforma: PlataformaDisponibilidade) {
    // Fora de hoje, "disponível/em uso" descreveria o AGORA e não o dia exibido; manutenção
    // e inativa valem para qualquer data.
    if ((plataforma.status === "disponivel" || plataforma.status === "reservada") && agoraMin === null) return null;
    return (
      <span className={`${styles.chip} ${CLASSE_CHIP_STATUS[plataforma.status]}`}>
        {ROTULO_STATUS_PLATAFORMA[plataforma.status]}
      </span>
    );
  }

  function acaoProximo(linha: LinhaModelo) {
    const { plataforma } = linha;
    // Data passada: nada mais pode ser reservado ali e o aviso geral já oferece "Ver próximo dia";
    // uma busca por linha só repetiria o mesmo convite em todas as plataformas.
    if (plataforma.indisponivel || linha.livres.length > 0 || !data || dataPassada) return null;
    const estado = proximos[chaveProximo(plataforma.id)];

    if (!estado || estado.estado === "erro") {
      return (
        <div className={styles.acaoProximo}>
          {estado?.estado === "erro" && (
            <span className={styles.acaoProximoTexto} role="alert">
              {estado.mensagem}
            </span>
          )}
          <button type="button" className={styles.btnAcao} onClick={() => void buscarProximo(plataforma.id)}>
            <CalendarSearch size={14} strokeWidth={2} aria-hidden="true" />
            {estado ? "Tentar novamente" : "Próximo horário livre"}
          </button>
        </div>
      );
    }
    if (estado.estado === "carregando") {
      return (
        <div className={styles.acaoProximo}>
          <span className={styles.acaoProximoTexto} role="status">
            Buscando o próximo horário livre…
          </span>
        </div>
      );
    }
    const { resposta } = estado;
    if (!resposta.encontrado || !resposta.data || resposta.inicioMin === null || resposta.fimMin === null) {
      return (
        <div className={styles.acaoProximo}>
          <span className={styles.acaoProximoTexto} role="status">
            Sem horário livre nos próximos {LIMITE_DIAS_PROXIMO} dias.
          </span>
        </div>
      );
    }
    const rotuloProximo = `${diaDaSemanaCurto(resposta.data)} ${dataCurta(resposta.data)} ${minutosParaHora(resposta.inicioMin)}`;
    return (
      <div className={styles.acaoProximo}>
        <span className={styles.acaoProximoTexto} role="status">
          Próximo horário livre: <strong>{rotuloProximo}</strong>
        </span>
        {onSelecionarHorario && (
          <button
            type="button"
            className={`${styles.btnAcao} ${styles.btnAcaoPrimaria}`}
            onClick={() => selecionarProximo(plataforma.id, resposta)}
          >
            Reservar {rotuloProximo}
          </button>
        )}
        {resposta.data !== data && (
          <button type="button" className={styles.btnAcao} onClick={() => irPara(resposta.data as string)}>
            Ir para {dataCurta(resposta.data)}
          </button>
        )}
      </div>
    );
  }

  function legenda() {
    if (!modelo) return null;
    const itens: Array<{ chave: string; classe: string; rotulo: string; dica?: string }> = [
      { chave: "livre", classe: styles.tipoLivre, rotulo: "Livre" },
      { chave: "reservada", classe: META_TIPO.reservada.classe, rotulo: "Reservada" },
      { chave: "em_uso", classe: META_TIPO.em_uso.classe, rotulo: "Em uso" },
      ...(modelo.temPendente
        ? [{ chave: "pendente", classe: META_TIPO.pendente.classe, rotulo: "Pendente" }]
        : []),
      { chave: "concluida", classe: META_TIPO.concluida.classe, rotulo: "Concluída" },
      { chave: "bloqueio", classe: META_TIPO.bloqueio.classe, rotulo: "Bloqueio" },
      { chave: "bloqueio_global", classe: META_TIPO.bloqueio_global.classe, rotulo: "Bloqueio global" },
      { chave: "indisponivel", classe: styles.tipoIndisponivel, rotulo: "Indisponível" },
      ...(modelo.naoReservavelAteMin > modelo.janela.inicioMin
        ? [
            {
              chave: "passado",
              classe: styles.tipoPassado,
              rotulo: "Prazo encerrado",
              dica: "Horário que já passou ou que está dentro da antecedência mínima de reserva",
            },
          ]
        : []),
      ...(modelo.temPropria ? [{ chave: "propria", classe: styles.swatchPropria, rotulo: "Sua reserva" }] : []),
    ];
    return (
      <ul className={styles.legenda} aria-label="Legenda">
        {itens.map((item) => (
          <li key={item.chave} className={styles.legendaItem} title={item.dica}>
            <span className={`${styles.swatch} ${item.classe}`} aria-hidden="true" />
            {item.rotulo}
          </li>
        ))}
      </ul>
    );
  }

  // ---- Layout desktop: trilha horizontal -------------------------------------------------
  function trilhaDesktop(linha: LinhaModelo, m: Modelo) {
    const { plataforma } = linha;
    const naoReservavel = posicaoNaJanela({ inicioMin: m.janela.inicioMin, fimMin: m.naoReservavelAteMin }, m.janela);
    const rotuloIndisponivel = ROTULO_STATUS_PLATAFORMA[plataforma.status];

    return (
      <div
        className={styles.trilha}
        role="group"
        aria-label={`${plataforma.codigo} · ${plataforma.nome}`}
        style={{ "--horas": m.janela.horas.length } as CSSProperties}
      >
        {plataforma.indisponivel ? (
          <div
            className={`${styles.bloco} ${styles.blocoTotal} ${styles.tipoIndisponivel}`}
            role="img"
            aria-label={`Indisponível o dia todo · ${rotuloIndisponivel}`}
            title={`Indisponível o dia todo · ${rotuloIndisponivel}`}
          >
            {/* Rótulo preso ao canto visível (ver .rotuloFixo): a faixa cobre o dia todo e, com a
                trilha rolada, o texto sairia de vista junto com o início dela. */}
            <span className={styles.rotuloFixo}>
              {plataforma.status === "inativa" ? (
                <PowerOff size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Wrench size={13} strokeWidth={2} aria-hidden="true" />
              )}
              <span className={styles.blocoTexto}>Indisponível · {rotuloIndisponivel}</span>
            </span>
          </div>
        ) : (
          <>
            {naoReservavel && (
              <span
                className={`${styles.naoReservavel} ${styles.tipoPassado}`}
                style={{ left: naoReservavel.left, width: naoReservavel.width }}
                aria-hidden="true"
              />
            )}

            {linha.livres.map((trecho) => {
              const pos = posicaoNaJanela(trecho, m.janela);
              if (!pos) return null;
              const faixa = formatarFaixa(trecho.inicioMin, trecho.fimMin);
              const duracao = trecho.fimMin - trecho.inicioMin;
              // O texto só entra quando cabe: a 40px por hora, 60min = ícone, 120min = rótulo.
              const texto = duracao >= 120 ? `Livre ${faixa}` : duracao >= 60 ? "Livre" : "";
              const propriedades = {
                className: `${styles.livre} ${styles.tipoLivre}`,
                style: { left: pos.left, width: pos.width } as CSSProperties,
                title: `Livre ${faixa}${onSelecionarHorario ? " — clique para escolher o início" : ""}`,
                "data-livre": "",
              };
              return onSelecionarHorario ? (
                <button
                  key={`livre-${trecho.inicioMin}`}
                  type="button"
                  {...propriedades}
                  aria-label={`Reservar ${plataforma.nome}, livre das ${minutosParaHora(trecho.inicioMin)} às ${minutosParaHora(trecho.fimMin)}`}
                  onPointerMove={(e) => guiarPonteiro(e, trecho)}
                  onPointerLeave={soltarPonteiro}
                  onClick={(e) => aoClicarNoTrecho(e, linha, trecho)}
                >
                  {texto && <span className={styles.livreTexto}>{texto}</span>}
                </button>
              ) : (
                <div
                  key={`livre-${trecho.inicioMin}`}
                  {...propriedades}
                  role="img"
                  aria-label={`Livre ${faixa}`}
                >
                  {texto && <span className={styles.livreTexto}>{texto}</span>}
                </div>
              );
            })}

            {linha.ocupados.map((ocupado) => {
              const pos = posicaoNaJanela(ocupado, m.janela);
              if (!pos) return null;
              const meta = META_TIPO[ocupado.tipo];
              const duracao = ocupado.fimMin - ocupado.inicioMin;
              const { Icone } = meta;
              // Conteúdo escalonado pela duração: <60min só a cor/padrão (o texto está no
              // title/aria-label), 60–119 ícone, >=120 ícone + setor/rótulo.
              const rotuloBloco = ocupado.detalhe.split(" · ")[0] || meta.rotulo;
              return (
                <div
                  key={ocupado.chave}
                  className={[
                    styles.bloco,
                    meta.classe,
                    ocupado.propria ? styles.propria : "",
                    ocupado.sobrepoeLivre ? styles.semPonteiro : "",
                    ocupado.pendenteSobreposta ? styles.pendenteSobreposta : "",
                  ].join(" ")}
                  style={{ left: pos.left, width: pos.width }}
                  role="img"
                  aria-label={ocupado.descricao}
                  title={ocupado.descricao}
                  data-tipo={ocupado.tipo}
                >
                  {duracao >= 60 && !ocupado.pendenteSobreposta && (
                    <span className={styles.rotuloFixo}>
                      <Icone size={13} strokeWidth={2} aria-hidden="true" />
                      {duracao >= 120 && <span className={styles.blocoTexto}>{rotuloBloco}</span>}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}
        {agoraVisivel && agoraMin !== null && (
          <span className={styles.agora} style={{ left: `${percentualNaJanela(agoraMin, m.janela)}%` }} aria-hidden="true" />
        )}
      </div>
    );
  }

  function quadroDesktop(m: Modelo) {
    const estiloQuadro = { "--horas": m.janela.horas.length } as CSSProperties;
    return (
      <div
        className={styles.rolagem}
        ref={rolagemRef}
        role="region"
        aria-label="Linha do tempo de disponibilidade das plataformas"
        tabIndex={0}
      >
        <div className={styles.quadro} style={estiloQuadro}>
          <div className={styles.linhaCabecalho} aria-hidden="true">
            <div className={`${styles.colunaPlataforma} ${styles.colunaCabecalho}`} data-coluna-plataforma="">
              Plataforma
            </div>
            <div className={styles.escalaHoras}>
              {m.janela.horas.map((hora) => (
                <span key={hora} className={styles.hora}>
                  {String(hora).padStart(2, "0")}h
                </span>
              ))}
              {agoraVisivel && agoraMin !== null && (
                <span className={styles.agoraRotulo} style={{ left: `${percentualNaJanela(agoraMin, m.janela)}%` }}>
                  {minutosParaHora(agoraMin)}
                </span>
              )}
            </div>
          </div>

          <ul className={styles.linhas}>
            {m.linhas.map((linha) => (
              <li
                key={linha.plataforma.id}
                className={styles.linha}
                data-plataforma-id={linha.plataforma.id}
                data-status={linha.plataforma.status}
                data-indisponivel={linha.plataforma.indisponivel ? "" : undefined}
                data-sem-horario={!linha.plataforma.indisponivel && linha.livres.length === 0 ? "" : undefined}
              >
                <div className={styles.colunaPlataforma} data-coluna-plataforma="">
                  <span className={styles.codigo}>{linha.plataforma.codigo}</span>
                  <span className={styles.nomePlataforma} title={linha.plataforma.nome}>
                    {linha.plataforma.nome}
                  </span>
                  {chipStatus(linha.plataforma)}
                </div>
                <div className={styles.areaTrilha}>
                  {trilhaDesktop(linha, m)}
                  {acaoProximo(linha)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  // ---- Layout mobile: cartões -----------------------------------------------------------
  function cartaoMobile(linha: LinhaModelo, m: Modelo) {
    const { plataforma } = linha;
    const naoReservavel = posicaoNaJanela({ inicioMin: m.janela.inicioMin, fimMin: m.naoReservavelAteMin }, m.janela);
    const ativos = linha.ocupados.filter((o) => o.tipo !== "concluida");
    const concluidos = linha.ocupados.filter((o) => o.tipo === "concluida");
    const rotuloIndisponivel = ROTULO_STATUS_PLATAFORMA[plataforma.status];

    const itemOcupado = (o: OcupadoModelo) => {
      const meta = META_TIPO[o.tipo];
      const { Icone } = meta;
      return (
        <li key={o.chave} className={`${styles.ocupadoItem} ${o.tipo === "concluida" ? styles.ocupadoItemPassado : ""}`}>
          <Icone size={13} strokeWidth={2} aria-hidden="true" className={styles.ocupadoIcone} />
          <span className={styles.ocupadoHora}>{o.faixa}</span>
          <span className={styles.ocupadoDetalhe}>{o.detalhe}</span>
        </li>
      );
    };

    return (
      <li
        key={plataforma.id}
        className={styles.cartao}
        data-plataforma-id={plataforma.id}
        data-status={plataforma.status}
        data-indisponivel={plataforma.indisponivel ? "" : undefined}
        data-sem-horario={!plataforma.indisponivel && linha.livres.length === 0 ? "" : undefined}
      >
        <div className={styles.cartaoTopo}>
          <div className={styles.cartaoIdentidade}>
            <span className={styles.codigo}>{plataforma.codigo}</span>
            <span className={styles.nomePlataforma}>{plataforma.nome}</span>
          </div>
          {chipStatus(plataforma)}
        </div>

        {plataforma.indisponivel ? (
          <p className={styles.avisoIndisponivel}>
            <span className={`${styles.swatch} ${styles.tipoIndisponivel}`} aria-hidden="true" />
            Indisponível o dia todo · {rotuloIndisponivel}
          </p>
        ) : (
          <>
            {/* A barra é só um resumo visual do dia: o mesmo conteúdo está nos chips e na
                lista de ocupados logo abaixo, em texto. */}
            <div className={styles.miniBarra} aria-hidden="true">
              {naoReservavel && (
                <span
                  className={`${styles.miniSegmento} ${styles.tipoPassado}`}
                  style={{ left: naoReservavel.left, width: naoReservavel.width }}
                />
              )}
              {linha.livres.map((trecho) => {
                const pos = posicaoNaJanela(trecho, m.janela);
                return pos ? (
                  <span
                    key={`livre-${trecho.inicioMin}`}
                    className={`${styles.miniSegmento} ${styles.tipoLivre}`}
                    style={{ left: pos.left, width: pos.width }}
                  />
                ) : null;
              })}
              {linha.ocupados.map((o) => {
                const pos = posicaoNaJanela(o, m.janela);
                return pos ? (
                  <span
                    key={o.chave}
                    className={`${styles.miniSegmento} ${META_TIPO[o.tipo].classe}`}
                    style={{ left: pos.left, width: pos.width }}
                  />
                ) : null;
              })}
              {agoraVisivel && agoraMin !== null && (
                <span className={styles.agora} style={{ left: `${percentualNaJanela(agoraMin, m.janela)}%` }} />
              )}
            </div>
            <div className={styles.miniEscala} aria-hidden="true">
              <span>{minutosParaHora(m.janela.inicioMin)}</span>
              <span>{minutosParaHora(m.janela.fimMin)}</span>
            </div>

            {linha.livres.length > 0 ? (
              <ul className={styles.chipsLivres} aria-label={`Horários livres de ${plataforma.nome}`}>
                {linha.livres.map((trecho) => {
                  const faixa = formatarFaixa(trecho.inicioMin, trecho.fimMin);
                  return (
                    <li key={`livre-${trecho.inicioMin}`}>
                      {onSelecionarHorario ? (
                        <button
                          type="button"
                          className={`${styles.chipLivre} ${styles.tipoLivre}`}
                          aria-label={`Reservar ${plataforma.nome}, livre das ${minutosParaHora(trecho.inicioMin)} às ${minutosParaHora(trecho.fimMin)}`}
                          onClick={() => selecionar(linha, trecho.inicioMin)}
                        >
                          {faixa}
                        </button>
                      ) : (
                        <span className={`${styles.chipLivre} ${styles.tipoLivre}`}>{faixa}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.semLivre}>Sem horário livre neste dia.</p>
            )}

            {ativos.length > 0 && (
              <ul className={styles.ocupadosLista} aria-label="Horários ocupados">
                {ativos.map(itemOcupado)}
              </ul>
            )}
            {concluidos.length > 0 && (
              <details className={styles.concluidos}>
                <summary>Concluídas ({concluidos.length})</summary>
                <ul className={styles.ocupadosLista}>{concluidos.map(itemOcupado)}</ul>
              </details>
            )}
          </>
        )}

        {acaoProximo(linha)}
      </li>
    );
  }

  function esqueleto() {
    return (
      <div className={styles.esqueleto} role="status" aria-live="polite">
        <span className={styles.somenteLeitor}>Carregando a disponibilidade…</span>
        {Array.from({ length: 4 }).map((_, indice) => (
          <div key={indice} className={styles.esqueletoLinha} aria-hidden="true">
            <span className={styles.esqueletoBarra} style={{ width: "120px" }} />
            <span className={styles.esqueletoTrilha}>
              <span className={styles.esqueletoBarra} style={{ width: `${30 + ((indice * 17) % 40)}%` }} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  function corpo() {
    if (semPermissao) {
      return (
        <div className={styles.aviso} role="alert">
          Você não tem permissão para ver a disponibilidade.
        </div>
      );
    }
    if (!doDia && erro !== null) {
      return (
        <div className={styles.aviso} role="alert">
          <p>{erro}</p>
          <button type="button" className={styles.btnAcao} onClick={() => void recarregar()}>
            Tentar novamente
          </button>
        </div>
      );
    }
    if (carregandoInicial || !modelo || !data) return esqueleto();

    if (modelo.linhas.length === 0) {
      return (
        <div className={styles.vazio} role="status">
          <p className={styles.vazioTitulo}>Nenhuma plataforma cadastrada.</p>
        </div>
      );
    }

    return (
      <>
        {modelo.comLivre === 0 && (
          <div className={styles.vazio} role="status">
            <p className={styles.vazioTitulo}>Nenhuma plataforma disponível nesse período.</p>
            {dataPassada && <p className={styles.vazioDica}>Essa data já passou.</p>}
            <div className={styles.vazioAcoes}>
              <button type="button" className={styles.btnAcao} onClick={() => irPara(somarDias(data, 1))}>
                Ver próximo dia
                <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {legenda()}
        {desktop ? (
          quadroDesktop(modelo)
        ) : (
          <ul className={styles.cartoes}>{modelo.linhas.map((linha) => cartaoMobile(linha, modelo))}</ul>
        )}
      </>
    );
  }

  // ---- Render ---------------------------------------------------------------------------
  const podeRecolher = typeof onAlternarRecolhida === "function";
  const dataAtual = data ?? "";
  const ehHoje = hoje !== null && data === hoje;
  const ehAmanha = hoje !== null && data === somarDias(hoje, 1);

  return (
    <section className={styles.secao} aria-labelledby={idTitulo} data-recolhida={recolhida ? "" : undefined}>
      <header className={styles.cabecalho}>
        <div className={styles.cabecalhoTexto}>
          <h2 id={idTitulo} className={styles.titulo}>
            {podeRecolher ? (
              <button
                type="button"
                className={styles.tituloBotao}
                aria-expanded={!recolhida}
                aria-controls={idCorpo}
                onClick={onAlternarRecolhida}
              >
                <ChevronDown size={18} strokeWidth={2} aria-hidden="true" className={styles.tituloSeta} />
                {titulo}
              </button>
            ) : (
              titulo
            )}
          </h2>
          {!recolhida && resumo && (
            <p className={styles.resumo} role="status">
              {resumo}
            </p>
          )}
        </div>

        {!recolhida && (
          <div className={styles.navegacao} role="group" aria-label="Escolher o dia">
            <button
              type="button"
              className={`${styles.btnNav} ${styles.btnNavIcone}`}
              onClick={() => data && irPara(somarDias(data, -1))}
              disabled={!data}
              aria-label="Dia anterior"
            >
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${styles.btnNav} ${ehHoje ? styles.btnNavAtivo : ""}`}
              onClick={() => irPara(hojeISO())}
              aria-pressed={ehHoje}
              disabled={!montado}
            >
              Hoje
            </button>
            <button
              type="button"
              className={`${styles.btnNav} ${ehAmanha ? styles.btnNavAtivo : ""}`}
              onClick={() => irPara(somarDias(hojeISO(), 1))}
              aria-pressed={ehAmanha}
              disabled={!montado}
            >
              Amanhã
            </button>
            <button
              type="button"
              className={`${styles.btnNav} ${styles.btnNavIcone}`}
              onClick={() => data && irPara(somarDias(data, 1))}
              disabled={!data}
              aria-label="Próximo dia"
            >
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <label className={styles.somenteLeitor} htmlFor={`${idBase}-data`}>
              Data
            </label>
            <input
              id={`${idBase}-data`}
              type="date"
              className={styles.campoData}
              value={dataAtual}
              onChange={(e) => irPara(e.target.value)}
              disabled={!data}
            />
          </div>
        )}
      </header>

      {!recolhida && (
        <div id={idCorpo} className={styles.corpo} aria-busy={carregando || carregandoInicial}>
          {corpo()}
        </div>
      )}
    </section>
  );
}
