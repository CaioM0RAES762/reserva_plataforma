"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  MINUTOS_DIA,
  PASSO_MINUTOS_PADRAO,
  ULTIMO_MINUTO_RESERVAVEL,
  calcularJanelaGrade,
  horaParaMinutos,
  minutosParaHora,
  type RegrasAgendaPublicas,
} from "@plataformares/shared";
import { ArrowUpToLine, ChevronLeft, ChevronRight, PanelRight, Plus } from "lucide-react";
import styles from "../app/(app)/calendario/page.module.css";
import { apiFetch } from "../lib/api";
import { invalidarDisponibilidade } from "../lib/useDisponibilidade";
import { useEventosSSE } from "../lib/useEventosSSE";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";
import { ReservaModal, type ReservaFormValues, type ReservaValoresIniciais } from "./ReservaModal";

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
// Semana começa na segunda (mesma convenção de inicioDaSemana) na grade mensal e no mini
// calendário.
const DIAS_SEMANA_SEG = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// Grade proporcional: 1 minuto = ROW_HEIGHT_PX/60 pixels — eventos e bloqueios são
// posicionados por horário real (não mais "encaixados" numa célula de hora fixa), então a
// altura de cada bloco reflete a duração de verdade. As linhas da grade NÃO são mais
// hardcoded (antes 06..20): a janela vem do expediente configurado pelo Admin — ver
// `janela` no componente. A grade cresce naturalmente; a rolagem vertical é da página.
const ROW_HEIGHT_PX = 60;
const MIN_EVENT_HEIGHT_PX = 22;
type PeriodoDias = 1 | 3 | 7;

// "3dias" só aparece no seletor até 1100px (tablet), onde é a view inicial — no desktop o
// seletor é Dia | Semana | Mês.
type Visao = "dia" | "3dias" | "semana" | "mes";
const DIAS_DA_VISAO: Record<Exclude<Visao, "mes">, PeriodoDias> = { dia: 1, "3dias": 3, semana: 7 };
const VISOES: Array<{ id: Visao; rotulo: string }> = [
  { id: "dia", rotulo: "Dia" },
  { id: "3dias", rotulo: "3 dias" },
  { id: "semana", rotulo: "Semana" },
  { id: "mes", rotulo: "Mês" },
];
// Quantos eventos cabem numa célula da view Mês antes do "+N".
const EVENTOS_POR_DIA_MES = 3;
// Acima deste corte o painel direito fica ancorado ao lado da grade; abaixo vira popover
// aberto pelo botão "Filtros". Espelha o @media de page.module.css.
const MQ_PAINEL_ANCORADO = "(min-width: 1280px)";
const STORAGE_PAINEL_OCULTO = "plataformares:calendario-painel-oculto";

// Janela do dia inteiro (00..23, grade termina em 24:00): usada enquanto o expediente não
// é conhecido, quando a busca das regras falha e quando o usuário pede "Ver dia inteiro".
// Nunca esconde dado — é o oposto de cair silenciosamente para um recorte fixo.
type Janela = ReturnType<typeof calcularJanelaGrade>;
const JANELA_DIA_INTEIRO: Janela = calcularJanelaGrade("00:00", "23:59");

// Revalidar as regras ao voltar o foco é barato, mas alternar de aba em sequência não
// pode virar uma rajada de requisições.
const INTERVALO_MIN_REVALIDAR_REGRAS_MS = 3000;
// Autorrolagem durante o arraste perto da borda do container.
const BORDA_AUTOROLAGEM_PX = 28;
const PASSO_AUTOROLAGEM_PX = 10;

interface Setor {
  id: string;
  nome: string;
  corHex: string;
}

interface PlataformaOpcao {
  id: string;
  nome: string;
}

interface Bloqueio {
  id: string;
  plataformaId: string | null;
  plataformaNome: string | null;
  dataInicio: string;
  dataFim: string;
  motivo: string;
}

interface CalendarioClientProps {
  usuarioId: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
  solicitanteNome: string;
  setorNome: string | null;
  telefonePerfil?: string | null;
}

interface TooltipState {
  x: number;
  y: number;
  conteudo: ReactNode;
}

interface EventoPosicionado {
  reserva: ReservaDetalhe;
  top: number;
  height: number;
  col: number;
  totalCols: number;
}

interface SegmentoBloqueio {
  inicioMin: number;
  fimMin: number;
}

interface DadosDoDia {
  dateStr: string;
  reservas: ReservaDetalhe[];
  bloqueios: Array<{ bloqueio: Bloqueio; segmento: SegmentoBloqueio }>;
}

// Retângulo fantasma do arraste: `fimMin` é exclusivo (encaixado em PASSO_MINUTOS_PADRAO).
interface SelecaoGrade {
  dataIso: string;
  inicioMin: number;
  fimMin: number;
}

// Estado mutável do arraste em curso. Fica em ref (não em state) porque é lido a cada
// pointermove/tick de autorrolagem — um state aqui forçaria um render por evento.
interface SessaoSelecao {
  dataIso: string;
  colunaEl: HTMLElement;
  pointerId: number;
  celulaAncora: number;
  celulaAtual: number;
  clientY: number;
}

function inicioDoDia(data: Date): Date {
  return new Date(data.getFullYear(), data.getMonth(), data.getDate());
}

function adicionarDias(data: Date, quantidade: number): Date {
  const proxima = inicioDoDia(data);
  proxima.setDate(proxima.getDate() + quantidade);
  return proxima;
}

function inicioDaSemana(data: Date): Date {
  const dia = data.getDay(); // 0 = domingo
  return adicionarDias(data, -dia + (dia === 0 ? -6 : 1));
}

function getPeriodDates(inicio: Date, quantidade: PeriodoDias): Date[] {
  return Array.from({ length: quantidade }, (_, indice) => adicionarDias(inicio, indice));
}

function primeiroDoMes(data: Date): Date {
  return new Date(data.getFullYear(), data.getMonth(), 1);
}

// Semanas completas (seg–dom) que cobrem o mês; `minimoDias` fixa 42 no mini calendário
// para a altura não pular entre meses de 5 e 6 semanas.
function diasDaGradeMensal(mes: Date, minimoDias = 0): Date[] {
  const ultimo = new Date(mes.getFullYear(), mes.getMonth() + 1, 0);
  const resultado: Date[] = [];
  for (let d = inicioDaSemana(primeiroDoMes(mes)); d <= ultimo || resultado.length % 7 !== 0 || resultado.length < minimoDias; d = adicionarDias(d, 1)) {
    resultado.push(d);
  }
  return resultado;
}

// Âncora (dataInicio) de cada view: segunda-feira na semana, dia 1 no mês, o próprio dia
// nas views de 1/3 dias.
function ancoraDaVisao(visao: Visao, data: Date): Date {
  if (visao === "semana") return inicioDaSemana(data);
  if (visao === "mes") return primeiroDoMes(data);
  return inicioDoDia(data);
}

function toIsoDate(d: Date): string {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function formatarLabel(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function capitalizar(texto: string): string {
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)}`;
}

// Rótulo do período no cabeçalho ("21–27 de setembro", "Qua, 23 de setembro",
// "Setembro"). O ano vai à parte, em tom secundário.
function formatarPeriodo(visao: Visao, dias: Date[], ancora: Date, hojeIso: string): string {
  if (visao === "mes") return capitalizar(MONTH_NAMES[ancora.getMonth()]);
  const primeiro = dias[0];
  const ultimo = dias[dias.length - 1];
  if (dias.length === 1) {
    const prefixo = toIsoDate(primeiro) === hojeIso ? "Hoje · " : "";
    return `${prefixo}${DAY_NAMES[primeiro.getDay()]}, ${primeiro.getDate()} de ${MONTH_NAMES[primeiro.getMonth()]}`;
  }
  if (primeiro.getMonth() === ultimo.getMonth() && primeiro.getFullYear() === ultimo.getFullYear()) {
    return `${primeiro.getDate()}–${ultimo.getDate()} de ${MONTH_NAMES[ultimo.getMonth()]}`;
  }
  return `${formatarLabel(primeiro).replace(/\./g, "")} – ${formatarLabel(ultimo).replace(/\./g, "")}`;
}

// Posição vertical de um minuto do dia dentro da janela; fora dela, encosta na borda.
function topPx(min: number, janela: Janela): number {
  const limitado = Math.min(Math.max(min, janela.inicioMin), janela.fimMin);
  return ((limitado - janela.inicioMin) / 60) * ROW_HEIGHT_PX;
}

function alturaPx(inicioMin: number, fimMin: number, janela: Janela): number {
  return Math.max(topPx(fimMin, janela) - topPx(inicioMin, janela), MIN_EVENT_HEIGHT_PX);
}

// Minuto do dia sob o ponteiro, sempre DENTRO da janela (o último minuto clicável é
// fimMin - 1, para que a célula de 30 min encontrada esteja inteira na grade).
function minutoNaColuna(colunaEl: HTMLElement, clientY: number, janela: Janela): number {
  const rect = colunaEl.getBoundingClientRect();
  const min = janela.inicioMin + ((clientY - rect.top) / ROW_HEIGHT_PX) * 60;
  return Math.min(Math.max(min, janela.inicioMin), janela.fimMin - 1);
}

function celulaDoMinuto(min: number): number {
  return Math.floor(min / PASSO_MINUTOS_PADRAO);
}

// Parte do bloqueio que cai dentro do dia [00:00, 24:00). Bloqueios podem atravessar dias
// (feriado de 3 dias, parada noturna) — cada dia mostra só o seu pedaço.
function segmentoDoBloqueioNoDia(b: Bloqueio, inicioDiaMs: number): SegmentoBloqueio | null {
  const inicioMin = Math.max((new Date(b.dataInicio).getTime() - inicioDiaMs) / 60000, 0);
  const fimMin = Math.min((new Date(b.dataFim).getTime() - inicioDiaMs) / 60000, MINUTOS_DIA);
  return fimMin > inicioMin ? { inicioMin, fimMin } : null;
}

// Algoritmo clássico de layout de agenda: eventos que se sobrepõem no tempo dividem a
// largura da coluna do dia entre si; eventos em clusters diferentes (sem sobreposição)
// cada um ocupa a largura toda.
function posicionarEventosDoDia(eventosDoDia: ReservaDetalhe[], janela: Janela): EventoPosicionado[] {
  // Reserva inteiramente fora da janela não desenha nada: sem este filtro `alturaPx` a
  // transformaria num toco de MIN_EVENT_HEIGHT_PX colado na borda da grade. Ela é contada
  // no aviso "fora do horário de expediente" — nunca some sem o usuário saber.
  const visiveis = eventosDoDia.filter(
    (r) => horaParaMinutos(r.horaFim) > janela.inicioMin && horaParaMinutos(r.horaInicio) < janela.fimMin
  );
  const ordenados = [...visiveis].sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
  const resultado: EventoPosicionado[] = [];
  let clusterEventos: { reserva: ReservaDetalhe; col: number }[] = [];
  let colunasFim: number[] = [];
  let clusterFimMax = -1;

  function fecharCluster() {
    const totalCols = colunasFim.length;
    for (const item of clusterEventos) {
      const inicio = horaParaMinutos(item.reserva.horaInicio);
      const fim = horaParaMinutos(item.reserva.horaFim);
      resultado.push({
        reserva: item.reserva,
        top: topPx(inicio, janela),
        height: alturaPx(inicio, fim, janela),
        col: item.col,
        totalCols,
      });
    }
    clusterEventos = [];
    colunasFim = [];
    clusterFimMax = -1;
  }

  for (const reserva of ordenados) {
    const inicioMin = horaParaMinutos(reserva.horaInicio);
    const fimMin = horaParaMinutos(reserva.horaFim);
    if (clusterEventos.length > 0 && inicioMin >= clusterFimMax) {
      fecharCluster();
    }
    let colIndex = colunasFim.findIndex((fim) => fim <= inicioMin);
    if (colIndex === -1) {
      colIndex = colunasFim.length;
      colunasFim.push(fimMin);
    } else {
      colunasFim[colIndex] = fimMin;
    }
    clusterEventos.push({ reserva, col: colIndex });
    clusterFimMax = Math.max(clusterFimMax, fimMin);
  }
  fecharCluster();
  return resultado;
}

function regrasIguais(a: RegrasAgendaPublicas, b: RegrasAgendaPublicas): boolean {
  return (
    a.horarioExpedienteInicio === b.horarioExpedienteInicio &&
    a.horarioExpedienteFim === b.horarioExpedienteFim &&
    a.duracaoMaximaHoras === b.duracaoMaximaHoras &&
    a.antecedenciaMinimaHoras === b.antecedenciaMinimaHoras
  );
}

function textoForaDoExpediente(reservas: number, bloqueios: number): string {
  const partes: string[] = [];
  if (reservas > 0) partes.push(`${reservas} ${reservas === 1 ? "reserva" : "reservas"}`);
  if (bloqueios > 0) partes.push(`${bloqueios} ${bloqueios === 1 ? "bloqueio" : "bloqueios"}`);
  const total = reservas + bloqueios;
  return `${partes.join(" e ")} fora do horário de expediente ${total === 1 ? "não aparece" : "não aparecem"} por inteiro na grade.`;
}

// `empresaTerceirizada` só existe em reservas do setor Terceirizados (null nos demais e nas
// anteriores à migration). Defensivo contra string vazia/espaços para o tooltip nunca
// exibir "Terceirizados · " com o complemento em branco.
function empresaDaReserva(r: ReservaDetalhe): string | null {
  const valor = r.empresaTerceirizada;
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

// Desktop (>1100px): a grade tem altura limitada à viewport e rola por dentro, com o
// cabeçalho dos dias fixo. Até 1100px ela cresce e quem rola é a página.
function rolaVerticalPorDentro(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== "hidden";
}

function prefereMenosMovimento(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const ICONE = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

function IconeSeta({ direcao }: { direcao: "esquerda" | "direita" }) {
  return direcao === "esquerda" ? <ChevronLeft {...ICONE} /> : <ChevronRight {...ICONE} />;
}

// Mini calendário do painel direito: navega o mês por conta própria (sem mexer na grade) e
// só leva a grade até a data quando o usuário escolhe um dia.
function MiniCalendario({
  mes,
  hojeIso,
  selecionados,
  onMudarMes,
  onSelecionar,
}: {
  mes: Date;
  hojeIso: string;
  selecionados: Set<string>;
  onMudarMes: (delta: number) => void;
  onSelecionar: (data: Date) => void;
}) {
  const dias = diasDaGradeMensal(mes, 42);
  return (
    <div className={styles.mini}>
      <div className={styles.miniHeader}>
        <span className={styles.miniTitulo} aria-live="polite">
          {capitalizar(MONTH_NAMES[mes.getMonth()])} <span className={styles.miniAno}>{mes.getFullYear()}</span>
        </span>
        <div className={styles.miniNav}>
          <button type="button" className={styles.miniNavBtn} onClick={() => onMudarMes(-1)} aria-label="Mês anterior">
            <IconeSeta direcao="esquerda" />
          </button>
          <button type="button" className={styles.miniNavBtn} onClick={() => onMudarMes(1)} aria-label="Próximo mês">
            <IconeSeta direcao="direita" />
          </button>
        </div>
      </div>
      <div className={styles.miniGrid}>
        {DIAS_SEMANA_SEG.map((nome) => (
          <span key={nome} className={styles.miniDow} aria-hidden="true">
            {nome.charAt(0)}
          </span>
        ))}
        {dias.map((d, i) => {
          const iso = toIsoDate(d);
          const selecionado = selecionados.has(iso);
          // Início/fim da faixa selecionada dentro de cada linha (seg–dom).
          const anteriorSel = i % 7 !== 0 && selecionados.has(toIsoDate(dias[i - 1]));
          const proximoSel = i % 7 !== 6 && i + 1 < dias.length && selecionados.has(toIsoDate(dias[i + 1]));
          const classes = [
            styles.miniDia,
            d.getMonth() !== mes.getMonth() ? styles.miniDiaFora : "",
            selecionado ? styles.miniDiaSelecionado : "",
            selecionado && !anteriorSel ? styles.miniDiaSelInicio : "",
            selecionado && !proximoSel ? styles.miniDiaSelFim : "",
            iso === hojeIso ? styles.miniDiaHoje : "",
          ].join(" ");
          return (
            <button
              key={iso}
              type="button"
              className={classes}
              onClick={() => onSelecionar(d)}
              aria-label={d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}
              aria-current={iso === hojeIso ? "date" : undefined}
              aria-pressed={selecionado}
            >
              <span className={styles.miniNum}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarioClient({
  usuarioId,
  perfil,
  setorId,
  solicitanteNome,
  setorNome,
  telefonePerfil,
}: CalendarioClientProps) {
  // O primeiro render é estável para SSR. Antes de buscar dados, o layout escolhe a view
  // inicial pelo espaço disponível: 1 dia no celular, 3 no tablet e 7 no desktop.
  const [visao, setVisao] = useState<Visao>("semana");
  const [periodoPronto, setPeriodoPronto] = useState(false);
  const [dataInicio, setDataInicio] = useState(() => inicioDaSemana(new Date()));
  const [reservas, setReservas] = useState<ReservaDetalhe[]>([]);
  const [setores, setSetores] = useState<Setor[]>([]);
  const [bloqueios, setBloqueios] = useState<Bloqueio[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [reservaSelecionada, setReservaSelecionada] = useState<ReservaDetalhe | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [agora, setAgora] = useState(() => new Date());
  const [modalCriarAberto, setModalCriarAberto] = useState(false);
  const [valoresIniciaisCriar, setValoresIniciaisCriar] = useState<ReservaValoresIniciais | undefined>(undefined);
  const [bloqueioSelecionado, setBloqueioSelecionado] = useState<Bloqueio | null>(null);
  // Retorno da criação que pede explicação (solicitação aguardando aprovação).
  const [avisoCriacao, setAvisoCriacao] = useState<string | null>(null);

  // Painel direito (mini calendário + filtros). Ancorado (>=1280px) ele pode ser ocultado e a
  // preferência persiste; abaixo disso é um popover transitório.
  const [painelOculto, setPainelOculto] = useState(false);
  const [painelPopoverAberto, setPainelPopoverAberto] = useState(false);
  // Só informa o aria-expanded/title do botão; quem decide o layout é o CSS (sem flash
  // antes da hidratação).
  const [painelAncorado, setPainelAncorado] = useState(true);
  const painelRef = useRef<HTMLElement>(null);
  const painelBotaoRef = useRef<HTMLButtonElement>(null);
  const [miniMes, setMiniMes] = useState(() => primeiroDoMes(new Date()));

  // Filtros: tudo visível por padrão. Setores guardam o que foi DESMARCADO, assim um setor
  // novo (ou desconhecido) nunca some sem o usuário ter pedido.
  const [plataformas, setPlataformas] = useState<PlataformaOpcao[]>([]);
  const [plataformaFiltro, setPlataformaFiltro] = useState("");
  const [setoresOcultos, setSetoresOcultos] = useState<Set<string>>(() => new Set());
  const [mostrarBloqueios, setMostrarBloqueios] = useState(true);
  const primeiraCarga = useRef(true);
  const carregarSeq = useRef(0);
  const metadadosCarregados = useRef(false);

  // Regras de agenda (expediente) — fonte da verdade da janela da grade.
  const [regras, setRegras] = useState<RegrasAgendaPublicas | null>(null);
  const [regrasStatus, setRegrasStatus] = useState<"carregando" | "ok" | "erro">("carregando");
  const [regrasBuscando, setRegrasBuscando] = useState(false);
  const [verDiaInteiro, setVerDiaInteiro] = useState(false);
  const regrasSeq = useRef(0);
  const regrasEmVoo = useRef(false);
  const regrasUltimaBusca = useRef(0);

  // Seleção por arraste (só mouse). O container só rola horizontalmente; verticalmente a
  // página é a única superfície rolável.
  const [selecao, setSelecao] = useState<SelecaoGrade | null>(null);
  const [selecionando, setSelecionando] = useState(false);
  const sessaoRef = useRef<SessaoSelecao | null>(null);
  const cliqueDeMouseTratadoRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const rolagemInicialFeitaRef = useRef(false);
  const rolarParaAgoraPendenteRef = useRef(false);

  // `hojeIso` acompanha o relógio (e não uma foto tirada na montagem): com a aba aberta
  // na virada do dia, o destaque de "hoje" e a semana atual continuam corretos.
  const hojeIso = toIsoDate(agora);
  const ehMes = visao === "mes";
  // Colunas da grade horária (na view Mês não há grade horária; 7 só dimensiona o skeleton).
  const periodoDias: PeriodoDias = ehMes ? 7 : DIAS_DA_VISAO[visao];
  const dias = useMemo(
    () => (visao === "mes" ? diasDaGradeMensal(dataInicio) : getPeriodDates(dataInicio, DIAS_DA_VISAO[visao])),
    [dataInicio, visao]
  );
  const setorPorId = useMemo(() => new Map(setores.map((s) => [s.id, s])), [setores]);

  useLayoutEffect(() => {
    const largura = window.innerWidth;
    const inicial: Visao = largura <= 767 ? "dia" : largura <= 1100 ? "3dias" : "semana";
    setVisao(inicial);
    setDataInicio(ancoraDaVisao(inicial, new Date()));
    setPeriodoPronto(true);
    try {
      setPainelOculto(window.localStorage.getItem(STORAGE_PAINEL_OCULTO) === "1");
    } catch {
      // Storage indisponível — painel segue visível.
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(MQ_PAINEL_ANCORADO);
    const sincronizar = () => setPainelAncorado(mq.matches);
    sincronizar();
    mq.addEventListener("change", sincronizar);
    return () => mq.removeEventListener("change", sincronizar);
  }, []);

  // O mini calendário acompanha a grade sempre que ela muda de período.
  useEffect(() => {
    setMiniMes(primeiroDoMes(dataInicio));
  }, [dataInicio]);

  // Lista de plataformas do filtro. Falha aqui não pode derrubar a agenda: o filtro cai
  // para as plataformas que aparecem nas reservas/bloqueios carregados.
  useEffect(() => {
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((dados) => setPlataformas(dados.map(({ id, nome }) => ({ id, nome }))))
      .catch(() => setPlataformas([]));
  }, []);

  const carregar = useCallback(async () => {
    const minhaBusca = ++carregarSeq.current;
    if (primeiraCarga.current) setCarregando(true);
    setErro(null);
    try {
      const dateFrom = toIsoDate(dias[0]);
      const dateTo = toIsoDate(dias[dias.length - 1]);
      const precisaMetadados = !metadadosCarregados.current;
      const [dadosReservas, dadosSetores, dadosBloqueios] = await Promise.all([
        apiFetch<ReservaDetalhe[]>(`/api/v1/reservas?dateFrom=${dateFrom}&dateTo=${dateTo}`),
        precisaMetadados ? apiFetch<Setor[]>("/api/v1/setores") : Promise.resolve(null),
        precisaMetadados ? apiFetch<Bloqueio[]>("/api/v1/bloqueios") : Promise.resolve(null),
      ]);
      if (minhaBusca !== carregarSeq.current) return;
      setReservas(dadosReservas);
      if (dadosSetores && dadosBloqueios) {
        setSetores(dadosSetores);
        setBloqueios(dadosBloqueios);
        metadadosCarregados.current = true;
      }
    } catch (err) {
      if (minhaBusca !== carregarSeq.current) return;
      setErro(err instanceof Error ? err.message : "Erro ao carregar calendário.");
    } finally {
      if (minhaBusca !== carregarSeq.current) return;
      primeiraCarga.current = false;
      setCarregando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias]);

  useEffect(() => {
    if (periodoPronto) void carregar();
  }, [carregar, periodoPronto]);

  // Busca o expediente configurado. A sequência descarta respostas fora de ordem (SSE +
  // foco + retry podem disparar buscas sobrepostas). Se já havia regras válidas e a
  // revalidação falha, MANTÉM as últimas conhecidas — são dados reais, não um recorte
  // inventado; só quando nunca houve regras a grade cai para o dia inteiro com aviso.
  const carregarRegras = useCallback(async () => {
    const minha = ++regrasSeq.current;
    regrasEmVoo.current = true;
    regrasUltimaBusca.current = Date.now();
    setRegrasBuscando(true);
    try {
      const dados = await apiFetch<RegrasAgendaPublicas>("/api/v1/configuracoes/regras-reserva");
      if (minha !== regrasSeq.current) return;
      // Mesmo conteúdo → mesma referência: não recalcula a janela nem mexe na rolagem.
      setRegras((atual) => (atual && regrasIguais(atual, dados) ? atual : dados));
      setRegrasStatus("ok");
    } catch {
      if (minha !== regrasSeq.current) return;
      setRegrasStatus("erro");
    } finally {
      if (minha === regrasSeq.current) {
        regrasEmVoo.current = false;
        setRegrasBuscando(false);
      }
    }
  }, []);

  useEffect(() => {
    void carregarRegras();
  }, [carregarRegras]);

  // O Admin pode ter mudado o expediente enquanto esta aba ficava em segundo plano (e o
  // SSE não entrega o que aconteceu com a aba suspensa): revalida ao voltar o foco.
  useEffect(() => {
    function aoVoltar() {
      if (document.visibilityState !== "visible") return;
      if (regrasEmVoo.current) return;
      if (Date.now() - regrasUltimaBusca.current < INTERVALO_MIN_REVALIDAR_REGRAS_MS) return;
      void carregarRegras();
    }
    document.addEventListener("visibilitychange", aoVoltar);
    window.addEventListener("focus", aoVoltar);
    return () => {
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("focus", aoVoltar);
    };
  }, [carregarRegras]);

  // Relógio ao vivo para a linha do "agora" — atualiza a cada minuto, sem F5.
  useEffect(() => {
    const timer = setInterval(() => setAgora(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // RNF-10: reservas criadas/alteradas em qualquer outra tela (Dashboard, outro usuário)
  // refletem aqui sem precisar recarregar a página; `configuracao.atualizada` traz a nova
  // janela de expediente. A disponibilidade em cache é descartada junto — a Nova Reserva
  // aberta a partir desta tela não pode enxergar o estado de antes do evento.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) {
        invalidarDisponibilidade();
        void carregar();
      } else if (tipo === "configuracao.atualizada") {
        void carregarRegras();
      }
    },
  });

  // ---------- Janela da grade ----------
  const janelaExpediente = useMemo(
    () => (regras ? calcularJanelaGrade(regras.horarioExpedienteInicio, regras.horarioExpedienteFim) : null),
    [regras]
  );
  const aguardandoRegras = !regras && regrasStatus === "carregando";
  const regrasIndisponiveis = !regras && regrasStatus === "erro";
  // Sem expediente conhecido (carregando/erro) ou com "Ver dia inteiro": dia inteiro.
  const janela: Janela = janelaExpediente && !verDiaInteiro ? janelaExpediente : JANELA_DIA_INTEIRO;
  const alturaGradePx = janela.horas.length * ROW_HEIGHT_PX;
  const gridVisivel = !carregando && !aguardandoRegras;
  const rotuloJanela = `${minutosParaHora(janela.inicioMin)}–${minutosParaHora(janela.fimMin)}`;

  const janelaRef = useRef(janela);
  useLayoutEffect(() => {
    janelaRef.current = janela;
  });

  // Na view Mês a grade inclui dias dos meses vizinhos; "período atual" é o mês.
  const periodoContemHoje = ehMes
    ? dataInicio.getFullYear() === agora.getFullYear() && dataInicio.getMonth() === agora.getMonth()
    : dias.some((dia) => toIsoDate(dia) === hojeIso);
  const nowMin = agora.getHours() * 60 + agora.getMinutes();
  const agoraNaJanela = nowMin >= janela.inicioMin && nowMin < janela.fimMin;

  // ---------- Filtros ----------
  const reservasFiltradas = useMemo(
    () =>
      reservas.filter(
        (r) => !setoresOcultos.has(r.setorId) && (!plataformaFiltro || r.plataformaId === plataformaFiltro)
      ),
    [reservas, setoresOcultos, plataformaFiltro]
  );
  // Bloqueio global (sem plataforma) vale para qualquer filtro de plataforma.
  const bloqueiosFiltrados = useMemo(
    () =>
      mostrarBloqueios
        ? bloqueios.filter((b) => !plataformaFiltro || b.plataformaId === null || b.plataformaId === plataformaFiltro)
        : [],
    [bloqueios, mostrarBloqueios, plataformaFiltro]
  );
  const opcoesPlataforma = useMemo(() => {
    if (plataformas.length > 0) return [...plataformas].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    const vistas = new Map<string, string>();
    for (const r of reservas) vistas.set(r.plataformaId, r.plataformaNome);
    for (const b of bloqueios) if (b.plataformaId && b.plataformaNome) vistas.set(b.plataformaId, b.plataformaNome);
    return [...vistas].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }, [plataformas, reservas, bloqueios]);
  const filtrosAtivos = setoresOcultos.size + (plataformaFiltro ? 1 : 0) + (mostrarBloqueios ? 0 : 1);

  function alternarSetor(id: string) {
    setSetoresOcultos((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });
  }

  function limparFiltros() {
    setSetoresOcultos(new Set());
    setPlataformaFiltro("");
    setMostrarBloqueios(true);
  }

  // Dados de cada dia do período carregado (reservas ativas + pedaço de cada bloqueio).
  const porDia = useMemo<DadosDoDia[]>(
    () =>
      dias.map((d) => {
        const dateStr = toIsoDate(d);
        const inicioDiaMs = new Date(`${dateStr}T00:00:00`).getTime();
        const bloqueiosDoDia: DadosDoDia["bloqueios"] = [];
        for (const bloqueio of bloqueiosFiltrados) {
          const segmento = segmentoDoBloqueioNoDia(bloqueio, inicioDiaMs);
          if (segmento) bloqueiosDoDia.push({ bloqueio, segmento });
        }
        return {
          dateStr,
          reservas: reservasFiltradas.filter((r) => r.status !== "cancelada" && r.status !== "rejeitada" && r.data === dateStr),
          bloqueios: bloqueiosDoDia,
        };
      }),
    [dias, reservasFiltradas, bloqueiosFiltrados]
  );

  // RN-RES-06: reservas urgentes podem ocorrer fora do expediente. Medido contra o
  // EXPEDIENTE (não contra a janela exibida), para o aviso — e o botão de voltar — seguirem
  // visíveis também depois de expandir para o dia inteiro.
  const foraDoExpediente = useMemo(() => {
    if (!janelaExpediente) return { reservas: 0, bloqueios: 0 };
    let reservasFora = 0;
    const bloqueiosOcultos = new Set<string>();
    for (const dia of porDia) {
      for (const r of dia.reservas) {
        if (
          horaParaMinutos(r.horaInicio) < janelaExpediente.inicioMin ||
          horaParaMinutos(r.horaFim) > janelaExpediente.fimMin
        ) {
          reservasFora += 1;
        }
      }
      // Bloqueio só conta quando o pedaço do dia está TODO fora: um bloqueio de dia
      // inteiro já aparece cobrindo a janela e não esconde informação nenhuma.
      for (const { bloqueio, segmento } of dia.bloqueios) {
        if (segmento.fimMin <= janelaExpediente.inicioMin || segmento.inicioMin >= janelaExpediente.fimMin) {
          bloqueiosOcultos.add(bloqueio.id);
        }
      }
    }
    return { reservas: reservasFora, bloqueios: bloqueiosOcultos.size };
  }, [porDia, janelaExpediente]);
  const totalForaDoExpediente = foraDoExpediente.reservas + foraDoExpediente.bloqueios;
  const mostrarAvisoFora = !ehMes && !!janelaExpediente && (totalForaDoExpediente > 0 || verDiaInteiro);

  const semReservasNoPeriodo = porDia.every((dia) => dia.reservas.length === 0);

  // ---------- Rolagem ----------
  function comportamentoDeRolagem(): ScrollBehavior {
    return prefereMenosMovimento() ? "auto" : "smooth";
  }

  function rolarPaginaParaAgora(behavior: ScrollBehavior) {
    const linhaAgora = scrollRef.current?.querySelector<HTMLElement>("[data-cal-agora]");
    linhaAgora?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
  }

  // Na primeira entrada em um período que contém hoje, posiciona a grade perto do horário
  // atual (no desktop a grade rola por dentro; até 1100px quem rola é a página — o
  // scrollIntoView serve aos dois). A troca de view não repete o salto; "Agora" continua
  // disponível.
  useEffect(() => {
    if (ehMes || !gridVisivel || !periodoContemHoje || !agoraNaJanela) return;
    if (!rolagemInicialFeitaRef.current || rolarParaAgoraPendenteRef.current) {
      const behavior = rolagemInicialFeitaRef.current ? comportamentoDeRolagem() : "auto";
      rolagemInicialFeitaRef.current = true;
      rolarParaAgoraPendenteRef.current = false;
      requestAnimationFrame(() => rolarPaginaParaAgora(behavior));
    }
  }, [ehMes, gridVisivel, periodoContemHoje, agoraNaJanela, dataInicio, visao]);

  // A rolagem horizontal continua pertencendo ao viewport da grade. No mobile, ao voltar
  // para um período com hoje, garante que a coluna atual apareça inteira.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!gridVisivel || !el || !periodoContemHoje) return;
    if (el.scrollWidth > el.clientWidth) {
      const colunaHoje = el.querySelector<HTMLElement>('[data-cal-cabecalho][data-hoje="true"]');
      const eixo = el.querySelector<HTMLElement>(`.${styles.calCornerCell}`);
      if (colunaHoje && eixo) {
        const elRect = el.getBoundingClientRect();
        const colRect = colunaHoje.getBoundingClientRect();
        const esquerda = colRect.left - elRect.left + el.scrollLeft;
        const direita = esquerda + colRect.width;
        const visivelDe = el.scrollLeft + eixo.offsetWidth;
        const visivelAte = el.scrollLeft + el.clientWidth;
        // Só rola quando o dia de hoje não está inteiro à vista: no desktop, onde as sete
        // colunas cabem, a grade continua começando na segunda-feira.
        if (esquerda < visivelDe || direita > visivelAte) {
          el.scrollLeft = Math.max(0, esquerda - eixo.offsetWidth);
        }
      }
    }
  }, [gridVisivel, periodoContemHoje, dataInicio, visao]);

  function irParaAgora() {
    // Em outro período, "Agora" também volta para o período atual; o efeito acima aguarda
    // a nova grade e então rola até a linha do horário atual.
    if (!periodoContemHoje) {
      rolarParaAgoraPendenteRef.current = true;
      setDataInicio(ancoraDaVisao(visao, new Date()));
      return;
    }
    if (agoraNaJanela) rolarPaginaParaAgora(comportamentoDeRolagem());
  }

  function irParaTopo() {
    const behavior = comportamentoDeRolagem();
    const el = scrollRef.current;
    if (el && rolaVerticalPorDentro(el)) el.scrollTo({ top: 0, behavior });
    else gridWrapRef.current?.scrollIntoView({ behavior, block: "start" });
  }

  // ---------- Criação a partir da grade ----------
  function abrirCriacao(dataIso: string, inicioMin: number, fimMin: number) {
    // O modal é quem decide/valida: aqui só pré-preenche. HH:mm nunca passa de 23:59 (a
    // reserva não aceita "24:00"), mesmo quando a grade termina à meia-noite.
    setValoresIniciaisCriar({
      plataformaId: "",
      motivo: "",
      prioridade: "normal",
      data: dataIso,
      horaInicio: minutosParaHora(inicioMin),
      horaFim: minutosParaHora(Math.min(fimMin, ULTIMO_MINUTO_RESERVAVEL)),
    });
    setModalCriarAberto(true);
  }

  // Clique/toque simples: 1h a partir da célula de 30 min tocada (ou até o fim da janela).
  function abrirCriacaoDeUmClique(dataIso: string, minutoClicado: number) {
    const inicio = celulaDoMinuto(minutoClicado) * PASSO_MINUTOS_PADRAO;
    abrirCriacao(dataIso, inicio, Math.min(inicio + 60, janela.fimMin));
  }

  const atualizarSelecao = useCallback((clientY: number) => {
    const sessao = sessaoRef.current;
    if (!sessao) return;
    sessao.clientY = clientY;
    sessao.celulaAtual = celulaDoMinuto(minutoNaColuna(sessao.colunaEl, clientY, janelaRef.current));
    // Voltar à célula de origem desfaz o retângulo: soltar ali é um clique simples.
    if (sessao.celulaAtual === sessao.celulaAncora) {
      setSelecao(null);
      return;
    }
    const proxima: SelecaoGrade = {
      dataIso: sessao.dataIso,
      inicioMin: Math.min(sessao.celulaAncora, sessao.celulaAtual) * PASSO_MINUTOS_PADRAO,
      fimMin: (Math.max(sessao.celulaAncora, sessao.celulaAtual) + 1) * PASSO_MINUTOS_PADRAO,
    };
    setSelecao((atual) =>
      atual && atual.dataIso === proxima.dataIso && atual.inicioMin === proxima.inicioMin && atual.fimMin === proxima.fimMin
        ? atual
        : proxima
    );
  }, []);

  const cancelarSelecao = useCallback(() => {
    const sessao = sessaoRef.current;
    sessaoRef.current = null;
    if (sessao) {
      // O clique que o navegador ainda vai disparar ao soltar o botão não pode abrir o modal.
      cliqueDeMouseTratadoRef.current = true;
      try {
        sessao.colunaEl.releasePointerCapture(sessao.pointerId);
      } catch {
        // captura já liberada — nada a fazer
      }
    }
    setSelecao(null);
    setSelecionando(false);
  }, []);

  // Enquanto há arraste: Esc cancela e a borda da área rolável rola a agenda — a própria
  // grade no desktop (abaixo do cabeçalho fixo dos dias) ou a página até 1100px.
  useEffect(() => {
    if (!selecionando) return;
    function aoTeclar(event: KeyboardEvent) {
      if (event.key === "Escape") cancelarSelecao();
    }
    const timer = setInterval(() => {
      const sessao = sessaoRef.current;
      if (!sessao) return;
      const el = scrollRef.current;
      const porDentro = !!el && rolaVerticalPorDentro(el);
      let topo = 0;
      let base = window.innerHeight;
      if (el && porDentro) {
        const rect = el.getBoundingClientRect();
        const cabecalho = el.querySelector<HTMLElement>("[data-cal-cabecalho-linha]");
        topo = rect.top + (cabecalho?.offsetHeight ?? 0);
        base = rect.bottom;
      }
      let delta = 0;
      if (sessao.clientY > base - BORDA_AUTOROLAGEM_PX) delta = PASSO_AUTOROLAGEM_PX;
      else if (sessao.clientY < topo + BORDA_AUTOROLAGEM_PX) delta = -PASSO_AUTOROLAGEM_PX;
      if (delta === 0) return;
      if (el && porDentro) {
        const antes = el.scrollTop;
        el.scrollBy({ top: delta });
        if (el.scrollTop !== antes) atualizarSelecao(sessao.clientY);
        return;
      }
      const antes = window.scrollY;
      window.scrollBy({ top: delta });
      if (window.scrollY !== antes) atualizarSelecao(sessao.clientY);
    }, 16);
    window.addEventListener("keydown", aoTeclar);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", aoTeclar);
    };
  }, [selecionando, cancelarSelecao, atualizarSelecao]);

  // Só o MOUSE arrasta. Em toque o arraste vertical é a rolagem da grade — capturá-lo aqui
  // brigaria com ela; por isso o toque continua sendo um tap (onClick abaixo).
  function aoPressionarColuna(event: ReactPointerEvent<HTMLDivElement>, dataIso: string) {
    cliqueDeMouseTratadoRef.current = false;
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    // Reservas e bloqueios existentes têm o seu próprio clique/tooltip.
    if ((event.target as HTMLElement).closest("[data-cal-item]")) return;
    const colunaEl = event.currentTarget;
    try {
      colunaEl.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const celula = celulaDoMinuto(minutoNaColuna(colunaEl, event.clientY, janela));
    sessaoRef.current = {
      dataIso,
      colunaEl,
      pointerId: event.pointerId,
      celulaAncora: celula,
      celulaAtual: celula,
      clientY: event.clientY,
    };
    setTooltip(null);
    setSelecionando(true);
  }

  function aoMoverNaColuna(event: ReactPointerEvent<HTMLDivElement>) {
    if (sessaoRef.current?.pointerId === event.pointerId) atualizarSelecao(event.clientY);
  }

  function aoSoltarNaColuna(event: ReactPointerEvent<HTMLDivElement>) {
    const sessao = sessaoRef.current;
    if (!sessao || sessao.pointerId !== event.pointerId) return;
    atualizarSelecao(event.clientY);
    sessaoRef.current = null;
    // O navegador dispara `click` logo depois do pointerup: já tratamos esta interação.
    cliqueDeMouseTratadoRef.current = true;
    setSelecao(null);
    setSelecionando(false);

    if (sessao.celulaAtual === sessao.celulaAncora) {
      abrirCriacaoDeUmClique(sessao.dataIso, sessao.celulaAncora * PASSO_MINUTOS_PADRAO);
      return;
    }
    const inicioMin = Math.min(sessao.celulaAncora, sessao.celulaAtual) * PASSO_MINUTOS_PADRAO;
    const fimMin = (Math.max(sessao.celulaAncora, sessao.celulaAtual) + 1) * PASSO_MINUTOS_PADRAO;
    abrirCriacao(sessao.dataIso, inicioMin, fimMin);
  }

  function aoClicarColuna(event: ReactMouseEvent<HTMLDivElement>, dataIso: string) {
    if (cliqueDeMouseTratadoRef.current) {
      cliqueDeMouseTratadoRef.current = false;
      return;
    }
    abrirCriacaoDeUmClique(dataIso, minutoNaColuna(event.currentTarget, event.clientY, janela));
  }

  async function handleSalvarNovaReserva(valores: ReservaFormValues) {
    const criada = await apiFetch<{ status?: string; aviso?: string; reservas?: Array<{ status: string }> }>(
      "/api/v1/reservas",
      { method: "POST", body: JSON.stringify(valores) }
    );
    const statusCriada = criada?.status ?? criada?.reservas?.[0]?.status;
    setAvisoCriacao(
      criada?.aviso ??
        (statusCriada === "pendente"
          ? "Solicitação enviada. Ela aparece tracejada no calendário até ser aprovada por um Admin ou Gestor do setor."
          : null)
    );
    // A disponibilidade em cache (TTL de segundos) ainda mostraria o horário como livre.
    invalidarDisponibilidade();
    setModalCriarAberto(false);
    setValoresIniciaisCriar(undefined);
    await carregar();
  }

  function navegarPeriodo(dir: number) {
    setDataInicio((atual) =>
      ehMes ? new Date(atual.getFullYear(), atual.getMonth() + dir, 1) : adicionarDias(atual, dir * periodoDias)
    );
  }

  function irParaHoje() {
    setDataInicio(ancoraDaVisao(visao, new Date()));
  }

  function mudarPeriodo(novaVisao: Visao) {
    if (novaVisao === visao) return;
    // Se o usuário está no período atual, cada view abre no ponto mais útil: hoje nas
    // views de 1/3 dias, segunda-feira na semana, o mês corrente no mês. Em datas
    // históricas, preserva a âncora.
    setDataInicio(ancoraDaVisao(novaVisao, periodoContemHoje ? new Date() : dataInicio));
    setVisao(novaVisao);
  }

  // Leva a grade até uma data (mini calendário, seletor nativo, número do dia). `visaoAlvo`
  // permite abrir direto o Dia a partir da semana/mês.
  function irParaData(data: Date, visaoAlvo: Visao = visao) {
    setVisao(visaoAlvo);
    setDataInicio(ancoraDaVisao(visaoAlvo, data));
    setPainelPopoverAberto(false);
  }

  function selecionarData(valor: string) {
    if (!valor) return;
    const selecionada = new Date(`${valor}T00:00:00`);
    if (!Number.isNaN(selecionada.getTime())) irParaData(selecionada);
  }

  function alternarPainel() {
    if (window.matchMedia(MQ_PAINEL_ANCORADO).matches) {
      setPainelOculto((atual) => {
        const proximo = !atual;
        try {
          window.localStorage.setItem(STORAGE_PAINEL_OCULTO, proximo ? "1" : "0");
        } catch {
          // Preferência só não persiste.
        }
        return proximo;
      });
    } else {
      setPainelPopoverAberto((aberto) => !aberto);
    }
  }

  function mostrarTooltip(event: ReactMouseEvent, conteudo: ReactNode) {
    if (sessaoRef.current) return;
    setTooltip({ x: event.clientX, y: event.clientY, conteudo });
  }

  function moverTooltip(event: ReactMouseEvent) {
    setTooltip((atual) => (atual ? { ...atual, x: event.clientX, y: event.clientY } : atual));
  }

  const periodoLabel = formatarPeriodo(visao, dias, dataInicio, hojeIso);
  const diasSelecionadosMini = useMemo(
    () => new Set(ehMes ? [] : dias.map((d) => toIsoDate(d))),
    [ehMes, dias]
  );

  // Popover do painel (<1280px): fecha ao clicar fora, com Esc e ao cruzar para o layout
  // ancorado (onde o mesmo painel passa a ficar sempre ao lado da grade).
  useEffect(() => {
    if (!painelPopoverAberto) return;
    function fecharAoClicarFora(event: PointerEvent) {
      const alvo = event.target as Node;
      if (painelRef.current?.contains(alvo) || painelBotaoRef.current?.contains(alvo)) return;
      setPainelPopoverAberto(false);
    }
    function fecharComEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPainelPopoverAberto(false);
        painelBotaoRef.current?.focus();
      }
    }
    const mq = window.matchMedia(MQ_PAINEL_ANCORADO);
    function aoMudarLayout(event: MediaQueryListEvent) {
      if (event.matches) setPainelPopoverAberto(false);
    }
    document.addEventListener("pointerdown", fecharAoClicarFora);
    window.addEventListener("keydown", fecharComEscape);
    mq.addEventListener("change", aoMudarLayout);
    return () => {
      document.removeEventListener("pointerdown", fecharAoClicarFora);
      window.removeEventListener("keydown", fecharComEscape);
      mq.removeEventListener("change", aoMudarLayout);
    };
  }, [painelPopoverAberto]);

  useEffect(() => {
    if (!bloqueioSelecionado) return;
    function fecharComEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setBloqueioSelecionado(null);
    }
    window.addEventListener("keydown", fecharComEscape);
    return () => window.removeEventListener("keydown", fecharComEscape);
  }, [bloqueioSelecionado]);

  function rotuloSetor(r: ReservaDetalhe): string {
    // Setor Terceirizados: a empresa acompanha o setor ("Terceirizados · ACME").
    const empresa = empresaDaReserva(r);
    return empresa ? `${r.setorNome} · ${empresa}` : r.setorNome;
  }

  function tooltipReserva(r: ReservaDetalhe): ReactNode {
    return (
      <>
        <strong>{r.plataformaNome}</strong>
        <div>
          {rotuloSetor(r)} · {r.solicitanteNome}
        </div>
        <div className={styles.tooltipMuted}>
          {r.horaInicio}–{r.horaFim} · {r.motivo}
        </div>
      </>
    );
  }

  function tooltipBloqueio(b: Bloqueio): ReactNode {
    return (
      <>
        <strong>Bloqueio de agenda</strong>
        <div>{b.plataformaNome ?? "Todas as plataformas"}</div>
        <div className={styles.tooltipMuted}>{b.motivo}</div>
      </>
    );
  }

  // A seta do select é desenhada pelo wrapper (a nativa varia por navegador).
  function seletorPlataforma(id: string, classeExtra = "") {
    return (
      <span className={`${styles.selectWrap} ${classeExtra}`}>
      <select
        id={id}
        className={styles.select}
        value={plataformaFiltro}
        onChange={(event) => setPlataformaFiltro(event.target.value)}
        aria-label="Filtrar por plataforma"
      >
        <option value="">Todas as plataformas</option>
        {opcoesPlataforma.map((p) => (
          <option key={p.id} value={p.id}>
            {p.nome}
          </option>
        ))}
      </select>
      </span>
    );
  }

  const rotuloPasso = ehMes ? "mês" : `${periodoDias} ${periodoDias === 1 ? "dia" : "dias"}`;
  const painelExpandido = painelAncorado ? !painelOculto : painelPopoverAberto;

  return (
    <section className={styles.page} onMouseMove={tooltip ? moverTooltip : undefined}>
      <div className={styles.header}>
        <div className={styles.headerTexto}>
          <h1 className={styles.pageTitulo}>Calendário</h1>
          <p className={styles.headerSubtitle}>Agenda de reservas por dia, semana e mês.</p>
        </div>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            setValoresIniciaisCriar(undefined);
            setModalCriarAberto(true);
          }}
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" /> Nova reserva
        </button>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.calNav} role="group" aria-label="Navegação de datas">
          <button
            type="button"
            className={`${styles.btnOutline} ${styles.btnHoje}`}
            onClick={irParaHoje}
            title={agora.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}
          >
            Hoje
          </button>
          <button
            type="button"
            className={`${styles.btnGhost} ${styles.btnIcon}`}
            onClick={() => navegarPeriodo(-1)}
            aria-label={ehMes ? "Mês anterior" : `Período anterior (${rotuloPasso})`}
          >
            <IconeSeta direcao="esquerda" />
          </button>
          <button
            type="button"
            className={`${styles.btnGhost} ${styles.btnIcon}`}
            onClick={() => navegarPeriodo(1)}
            aria-label={ehMes ? "Próximo mês" : `Próximo período (${rotuloPasso})`}
          >
            <IconeSeta direcao="direita" />
          </button>
          <label className={styles.datePickerLabel} title="Escolher uma data">
            <span className={styles.weekLabel}>{periodoLabel}</span>
            <input
              className={styles.datePickerInput}
              type="date"
              value={toIsoDate(dataInicio)}
              onChange={(event) => selecionarData(event.target.value)}
              aria-label="Escolher uma data"
            />
          </label>
        </div>

        <div className={styles.toolbarSecondary}>
          {!ehMes && gridVisivel && (
            <div className={styles.calScrollNav}>
              <button
                type="button"
                className={styles.btnOutline}
                onClick={irParaAgora}
                disabled={!agoraNaJanela}
                title={agoraNaJanela ? "Ir para o horário atual" : "O horário atual está fora do período exibido"}
              >
                Agora
              </button>
              <button
                type="button"
                className={`${styles.btnOutline} ${styles.btnIcon}`}
                onClick={irParaTopo}
                aria-label={`Ir para ${minutosParaHora(janela.inicioMin)}`}
                title={`Ir para ${minutosParaHora(janela.inicioMin)}`}
              >
                <ArrowUpToLine {...ICONE} />
              </button>
            </div>
          )}

          <div className={styles.periodSelector} role="group" aria-label="Visualização">
            {VISOES.map(({ id, rotulo }) => (
              <button
                key={id}
                type="button"
                className={[
                  styles.periodButton,
                  visao === id ? styles.periodButtonActive : "",
                  id === "3dias" ? styles.periodButtonTablet : "",
                ].join(" ")}
                aria-pressed={visao === id}
                onClick={() => mudarPeriodo(id)}
              >
                {rotulo}
              </button>
            ))}
          </div>

          <div className={styles.plataformaToolbar}>{seletorPlataforma("calendario-plataforma")}</div>

          <button
            type="button"
            ref={painelBotaoRef}
            className={`${styles.btnOutline} ${styles.painelToggle} ${painelExpandido ? styles.painelToggleAtivo : ""}`}
            onClick={alternarPainel}
            aria-expanded={painelExpandido}
            aria-controls="calendario-painel"
            title={painelAncorado ? (painelOculto ? "Mostrar painel lateral" : "Ocultar painel lateral") : undefined}
          >
            <PanelRight {...ICONE} />
            Filtros
            {filtrosAtivos > 0 && (
              <span className={styles.filtroIndicador} aria-label={`${filtrosAtivos} ${filtrosAtivos === 1 ? "filtro ativo" : "filtros ativos"}`} />
            )}
          </button>
        </div>
      </div>

      {erro && (
        <div className={styles.error} role="alert">
          <span>{erro}</span>
          <button type="button" className={styles.btnOutline} onClick={() => void carregar()}>
            Tentar novamente
          </button>
        </div>
      )}

      {/* Sem as regras NÃO se cai para um recorte fixo: a grade mostra o dia inteiro (nada
          fica escondido) e o usuário é avisado de que o expediente não pôde ser lido. */}
      {regrasIndisponiveis && (
        <div className={styles.calAviso} role="status" data-cal-aviso="regras-indisponiveis">
          <span className={styles.calAvisoTexto}>
            Não foi possível carregar o horário de expediente; exibindo o dia inteiro.
          </span>
          <button
            type="button"
            className={styles.btnOutline}
            onClick={() => void carregarRegras()}
            disabled={regrasBuscando}
          >
            {regrasBuscando ? "Tentando..." : "Tentar novamente"}
          </button>
        </div>
      )}

      {avisoCriacao && (
        <div className={styles.calAviso} role="status">
          <span className={styles.calAvisoTexto}>{avisoCriacao}</span>
          <button type="button" className={styles.btnOutline} onClick={() => setAvisoCriacao(null)}>
            Entendi
          </button>
        </div>
      )}

      {mostrarAvisoFora && janelaExpediente && (
        <div className={styles.calAviso} role="status" data-cal-aviso="fora-expediente">
          <span className={styles.calAvisoTexto}>
            {verDiaInteiro
              ? `Exibindo o dia inteiro. O expediente configurado é ${minutosParaHora(janelaExpediente.inicioMin)}–${minutosParaHora(janelaExpediente.fimMin)}.`
              : textoForaDoExpediente(foraDoExpediente.reservas, foraDoExpediente.bloqueios)}
          </span>
          <button type="button" className={styles.btnOutline} onClick={() => setVerDiaInteiro((atual) => !atual)}>
            {verDiaInteiro ? "Voltar ao expediente" : "Ver dia inteiro"}
          </button>
        </div>
      )}

      <div className={styles.layout}>
        <div ref={gridWrapRef} className={styles.calGridWrap}>
          {!gridVisivel || !periodoPronto ? (
            <div className={styles.calSkeleton} role="status" aria-busy="true" aria-label="Carregando calendário">
              {Array.from({ length: periodoDias }, (_, i) => (
                <div key={i} className={styles.calSkeletonCol} />
              ))}
            </div>
          ) : ehMes ? (
            <div
              ref={scrollRef}
              className={styles.mesScroll}
              role="region"
              aria-label={`Grade de reservas de ${MONTH_NAMES[dataInicio.getMonth()]} de ${dataInicio.getFullYear()}`}
              tabIndex={0}
            >
              <div className={styles.mesCabecalho} data-cal-cabecalho-linha="">
                {DIAS_SEMANA_SEG.map((nome) => (
                  <div key={nome} className={styles.mesDow}>
                    {nome}
                  </div>
                ))}
              </div>
              <div className={styles.mesGrid} style={{ "--mes-semanas": dias.length / 7 } as CSSProperties}>
                {porDia.map((dia, indice) => {
                  const d = dias[indice];
                  const isToday = dia.dateStr === hojeIso;
                  const ordenadas = [...dia.reservas].sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
                  const bloqueio = dia.bloqueios[0]?.bloqueio;
                  const visiveis = ordenadas.slice(0, bloqueio ? EVENTOS_POR_DIA_MES - 1 : EVENTOS_POR_DIA_MES);
                  const resto = ordenadas.length - visiveis.length + Math.max(dia.bloqueios.length - 1, 0);
                  const rotuloDia = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
                  return (
                    <div
                      key={dia.dateStr}
                      className={[
                        styles.mesCelula,
                        d.getMonth() !== dataInicio.getMonth() ? styles.mesCelulaFora : "",
                        isToday ? styles.today : "",
                      ].join(" ")}
                      data-data={dia.dateStr}
                      data-hoje={isToday ? "true" : undefined}
                      onClick={() =>
                        abrirCriacao(dia.dateStr, janela.inicioMin, Math.min(janela.inicioMin + 60, janela.fimMin))
                      }
                    >
                      <button
                        type="button"
                        className={styles.mesDiaNum}
                        onClick={(event) => {
                          event.stopPropagation();
                          irParaData(d, "dia");
                        }}
                        aria-label={`Abrir ${rotuloDia}`}
                        aria-current={isToday ? "date" : undefined}
                      >
                        {d.getDate()}
                      </button>
                      {bloqueio && (
                        <button
                          type="button"
                          className={styles.mesBloqueio}
                          data-cal-item="bloqueio"
                          aria-label={`Bloqueio: ${bloqueio.plataformaNome ?? "todas as plataformas"}, ${bloqueio.motivo}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setBloqueioSelecionado(bloqueio);
                          }}
                          onMouseEnter={(event) => mostrarTooltip(event, tooltipBloqueio(bloqueio))}
                          onMouseLeave={() => setTooltip(null)}
                        >
                          Indisponível
                        </button>
                      )}
                      {visiveis.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          className={`${styles.mesEvento} ${r.status === "pendente" ? styles.eventoPendente : ""}`}
                          style={{ "--ev": setorPorId.get(r.setorId)?.corHex ?? "#64748B" } as CSSProperties}
                          data-cal-item="reserva"
                          aria-label={`${r.plataformaNome}, ${r.horaInicio} às ${r.horaFim}, ${rotuloSetor(r)}${r.status === "pendente" ? ", pendente de aprovação" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setReservaSelecionada(r);
                          }}
                          onMouseEnter={(event) => mostrarTooltip(event, tooltipReserva(r))}
                          onMouseLeave={() => setTooltip(null)}
                        >
                          <span className={styles.mesEventoHora}>{r.horaInicio}</span>
                          <span className={styles.mesEventoTitulo}>{r.plataformaNome}</span>
                        </button>
                      ))}
                      {resto > 0 && (
                        <button
                          type="button"
                          className={styles.mesMais}
                          onClick={(event) => {
                            event.stopPropagation();
                            irParaData(d, "dia");
                          }}
                          aria-label={`Mais ${resto} em ${rotuloDia}`}
                        >
                          +{resto}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className={`${styles.calScroll} ${selecionando ? styles.calSelecionando : ""}`}
              role="region"
              aria-label={`Grade de reservas de ${periodoDias} ${periodoDias === 1 ? "dia" : "dias"}`}
              tabIndex={0}
              data-janela={`${minutosParaHora(janela.inicioMin)}-${minutosParaHora(janela.fimMin)}`}
            >
              <div
                className={styles.calInner}
                data-periodo={periodoDias}
                style={{ "--cal-hora": `${ROW_HEIGHT_PX}px`, "--cal-dias": periodoDias } as CSSProperties}
              >
                <div className={styles.calHeaderRow} data-cal-cabecalho-linha="">
                  <div className={styles.calCornerCell} />
                  {dias.map((d, i) => {
                    const isToday = toIsoDate(d) === hojeIso;
                    return (
                      <div
                        key={i}
                        className={`${styles.calHeaderCell} ${isToday ? styles.today : ""}`}
                        data-cal-cabecalho=""
                        data-hoje={isToday ? "true" : undefined}
                      >
                        <span className={styles.calHeaderDow}>{DAY_NAMES[d.getDay()]}</span>
                        {periodoDias === 1 ? (
                          <span className={styles.calHeaderDate}>{d.getDate()}</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.calHeaderDate}
                            onClick={() => irParaData(d, "dia")}
                            aria-label={`Abrir ${d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}`}
                          >
                            {d.getDate()}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className={styles.calBody}>
                  <div className={styles.calTimeAxis} style={{ height: alturaGradePx }}>
                    {janela.horas.map((h, i) => (
                      <span
                        key={h}
                        className={`${styles.calTimeAxisLabel} ${i === 0 ? styles.calTimeAxisLabelPrimeira : ""}`}
                        // A primeira hora fica DENTRO da grade: centralizada na linha ela
                        // invadiria o cabeçalho fixo e seria cortada por ele.
                        style={{ top: i === 0 ? 4 : i * ROW_HEIGHT_PX }}
                      >
                        {String(h).padStart(2, "0")}:00
                      </span>
                    ))}
                    {periodoContemHoje && agoraNaJanela && (
                      <span className={styles.calNowLabel} style={{ top: topPx(nowMin, janela) }} aria-hidden="true">
                        {minutosParaHora(nowMin)}
                      </span>
                    )}
                  </div>

                  {porDia.map((dia, dayIndex) => {
                    const dateStr = dia.dateStr;
                    const isToday = dateStr === hojeIso;
                    const posicionados = posicionarEventosDoDia(dia.reservas, janela);
                    const mostrarLinhaAgora = isToday && nowMin >= janela.inicioMin && nowMin <= janela.fimMin;
                    const selecaoDoDia = selecao && selecao.dataIso === dateStr ? selecao : null;

                    return (
                      <div
                        key={dayIndex}
                        className={`${styles.calDayColumn} ${isToday ? styles.today : ""}`}
                        style={{ height: alturaGradePx }}
                        data-data={dateStr}
                        data-hoje={isToday ? "true" : undefined}
                        onPointerDown={(event) => aoPressionarColuna(event, dateStr)}
                        onPointerMove={aoMoverNaColuna}
                        onPointerUp={aoSoltarNaColuna}
                        onPointerCancel={cancelarSelecao}
                        onLostPointerCapture={() => {
                          if (sessaoRef.current) cancelarSelecao();
                        }}
                        onClick={(event) => aoClicarColuna(event, dateStr)}
                      >
                        {dia.bloqueios.map(({ bloqueio: b, segmento }) => {
                          const bInicioMin = Math.max(segmento.inicioMin, janela.inicioMin);
                          const bFimMin = Math.min(segmento.fimMin, janela.fimMin);
                          if (bFimMin <= bInicioMin) return null;
                          const top = topPx(bInicioMin, janela);
                          const height = Math.max(topPx(bFimMin, janela) - top, MIN_EVENT_HEIGHT_PX);
                          return (
                            <button
                              key={b.id}
                              type="button"
                              className={styles.calBlockLabel}
                              style={{ top, height }}
                              data-cal-item="bloqueio"
                              aria-label={`Bloqueio: ${b.plataformaNome ?? "todas as plataformas"}, ${b.motivo}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setBloqueioSelecionado(b);
                              }}
                              onMouseEnter={(e) => mostrarTooltip(e, tooltipBloqueio(b))}
                              onMouseLeave={() => setTooltip(null)}
                            >
                              <span className={styles.calBlockTitle}>Indisponível</span>
                              {height >= 38 && <span className={styles.calBlockMeta}>{b.motivo}</span>}
                              {height >= 54 && (
                                <span className={styles.calBlockMeta}>{b.plataformaNome ?? "Todas as plataformas"}</span>
                              )}
                            </button>
                          );
                        })}

                        {mostrarLinhaAgora && (
                          <div
                            className={styles.calNowLine}
                            style={{ top: topPx(nowMin, janela) }}
                            data-cal-agora=""
                          >
                            <span className={styles.calNowDot} />
                          </div>
                        )}

                        {selecaoDoDia && (
                          <div
                            className={styles.calSelecao}
                            style={{
                              top: topPx(selecaoDoDia.inicioMin, janela),
                              height: topPx(selecaoDoDia.fimMin, janela) - topPx(selecaoDoDia.inicioMin, janela),
                            }}
                            data-cal-selecao=""
                            aria-hidden="true"
                          >
                            {minutosParaHora(selecaoDoDia.inicioMin)}–
                            {minutosParaHora(Math.min(selecaoDoDia.fimMin, ULTIMO_MINUTO_RESERVAVEL))}
                          </div>
                        )}

                        {posicionados.map(({ reserva: r, top, height, col, totalCols }) => {
                          const cor = setorPorId.get(r.setorId)?.corHex ?? "#64748B";
                          const widthPct = 100 / totalCols;
                          const setorRotulo = rotuloSetor(r);
                          // Hierarquia: plataforma → horário → setor, conforme a altura
                          // comporta linhas inteiras (nunca meia linha cortada).
                          return (
                            <button
                              key={r.id}
                              type="button"
                              className={`${styles.calEvent} ${r.status === "pendente" ? styles.eventoPendente : ""}`}
                              data-cal-item="reserva"
                              aria-label={`${r.plataformaNome}, ${r.horaInicio} às ${r.horaFim}, ${setorRotulo}${r.status === "pendente" ? ", pendente de aprovação" : ""}`}
                              style={
                                {
                                  top,
                                  height,
                                  left: `calc(${col * widthPct}% + 1px)`,
                                  width: `calc(${widthPct}% - 3px)`,
                                  "--ev": cor,
                                } as CSSProperties
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                setReservaSelecionada(r);
                              }}
                              onMouseEnter={(e) => mostrarTooltip(e, tooltipReserva(r))}
                              onMouseLeave={() => setTooltip(null)}
                            >
                              <span className={styles.calEventTitle}>
                                {r.plataformaNome}
                                {height < 38 && <span className={styles.calEventTimeInline}>{r.horaInicio}</span>}
                              </span>
                              {height >= 38 && (
                                <span className={styles.calEventTime}>
                                  {r.horaInicio}–{r.horaFim}
                                </span>
                              )}
                              {height >= 54 && <span className={styles.calEventMeta}>{setorRotulo}</span>}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Painel direito: ferramentas do calendário (não é navegação — essa é a sidebar).
            >=1280px fica ancorado ao lado da grade; abaixo, o mesmo painel vira popover. */}
        <aside
          ref={painelRef}
          id="calendario-painel"
          className={[
            styles.painel,
            painelOculto ? styles.painelOculto : "",
            painelPopoverAberto ? styles.painelPopoverAberto : "",
          ].join(" ")}
          aria-label="Ferramentas do calendário"
        >
          <div className={styles.painelSecao}>
            <MiniCalendario
              mes={miniMes}
              hojeIso={hojeIso}
              selecionados={diasSelecionadosMini}
              onMudarMes={(delta) => setMiniMes((atual) => new Date(atual.getFullYear(), atual.getMonth() + delta, 1))}
              onSelecionar={(data) => irParaData(data)}
            />
          </div>

          <div className={`${styles.painelSecao} ${styles.painelSecaoPlataforma}`}>
            <label className={styles.painelTitulo} htmlFor="calendario-plataforma-painel">
              Plataforma
            </label>
            {seletorPlataforma("calendario-plataforma-painel", styles.selectPainel)}
          </div>

          <div className={styles.painelSecao}>
            <div className={styles.painelTituloLinha}>
              <h2 className={styles.painelTitulo}>Setores</h2>
              {filtrosAtivos > 0 && (
                <button type="button" className={styles.linkBtn} onClick={limparFiltros}>
                  Limpar filtros
                </button>
              )}
            </div>
            <ul className={styles.filtroLista}>
              {setores.map((s) => (
                <li key={s.id}>
                  <label className={styles.filtroItem}>
                    <input
                      type="checkbox"
                      className={styles.filtroCheck}
                      style={{ "--cor": s.corHex } as CSSProperties}
                      checked={!setoresOcultos.has(s.id)}
                      onChange={() => alternarSetor(s.id)}
                    />
                    <span className={styles.filtroNome}>{s.nome}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.painelSecao}>
            <label className={styles.filtroItem}>
              <input
                type="checkbox"
                className={styles.filtroCheck}
                checked={mostrarBloqueios}
                onChange={() => setMostrarBloqueios((atual) => !atual)}
              />
              <span className={styles.filtroNome}>Bloqueios</span>
              <span className={styles.filtroHachura} aria-hidden="true" />
            </label>
          </div>

          {!ehMes && gridVisivel && (
            <div className={`${styles.painelSecao} ${styles.painelInfo}`}>
              <span className={styles.painelTitulo}>Horário exibido</span>
              <span className={styles.painelValor}>{rotuloJanela}</span>
              <p className={styles.painelNota}>
                <span className={styles.calDicaMouse}>Clique ou arraste em um horário vazio para criar uma reserva.</span>
                <span className={styles.calDicaToque}>Toque em um horário vazio para criar uma reserva.</span>
              </p>
              {semReservasNoPeriodo && !erro && <p className={styles.painelNota}>Nenhuma reserva neste período.</p>}
            </div>
          )}
        </aside>
      </div>

      {tooltip && (
        <div
          className={styles.calTooltip}
          style={{
            left: Math.min(tooltip.x + 16, (typeof window !== "undefined" ? window.innerWidth : 1280) - 240),
            top: Math.min(tooltip.y + 16, (typeof window !== "undefined" ? window.innerHeight : 800) - 100),
          }}
        >
          {tooltip.conteudo}
        </div>
      )}

      {bloqueioSelecionado && (
        <div
          className={styles.blockDialogOverlay}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBloqueioSelecionado(null);
          }}
        >
          <div className={styles.blockDialog} role="dialog" aria-modal="true" aria-labelledby="bloqueio-titulo">
            <div className={styles.blockDialogHeader}>
              <div>
                <span className={styles.blockDialogEyebrow}>Bloqueio de agenda</span>
                <h2 id="bloqueio-titulo">{bloqueioSelecionado.plataformaNome ?? "Todas as plataformas"}</h2>
              </div>
              <button
                type="button"
                className={`${styles.btnOutline} ${styles.btnIcon}`}
                onClick={() => setBloqueioSelecionado(null)}
                aria-label="Fechar detalhe do bloqueio"
                autoFocus
              >
                ×
              </button>
            </div>
            <div className={styles.blockDialogBody}>
              <p>{bloqueioSelecionado.motivo}</p>
              <dl>
                <div>
                  <dt>Início</dt>
                  <dd>{new Date(bloqueioSelecionado.dataInicio).toLocaleString("pt-BR")}</dd>
                </div>
                <div>
                  <dt>Fim</dt>
                  <dd>{new Date(bloqueioSelecionado.dataFim).toLocaleString("pt-BR")}</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      )}

      {modalCriarAberto && (
        <ReservaModal
          usuarioId={usuarioId}
          solicitanteNome={solicitanteNome}
          setorNome={setorNome}
          telefonePerfil={telefonePerfil}
          onClose={() => {
            setModalCriarAberto(false);
            setValoresIniciaisCriar(undefined);
          }}
          onSalvar={handleSalvarNovaReserva}
          valoresIniciais={valoresIniciaisCriar}
        />
      )}

      {reservaSelecionada && (
        <ReservaDetalheModal
          reserva={reservaSelecionada}
          perfil={perfil}
          setorId={setorId}
          onClose={() => setReservaSelecionada(null)}
          onAtualizado={async () => {
            setReservaSelecionada(null);
            await carregar();
          }}
        />
      )}
    </section>
  );
}
