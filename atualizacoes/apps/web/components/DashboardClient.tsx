"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { calcularJanelaAgendaEmCurso, calcularLanes, contarLanes } from "@plataformares/shared";
import { hojeBrasilia } from "./SeletorHorarioCalculos";
import styles from "../app/(app)/dashboard/page.module.css";
import { apiFetch } from "../lib/api";
import { useEventosSSE } from "../lib/useEventosSSE";

const CATEGORIA_LABEL: Record<string, string> = {
  elevatoria: "Elevatória",
  andaime: "Andaime",
  sala: "Sala técnica",
  patio: "Pátio",
  veiculo: "Veículo",
  outro: "Outro",
};

interface Kpis {
  totalPlataformas: number;
  disponiveis: number;
  emUso: number;
  manutencao: number;
  reservasHoje: number;
  reservasProximos7Dias: number;
  naoConformidadesRecentes: number;
  // Só Admin/Gestor (null para Colaborador): solicitações aguardando decisão.
  pendentesAprovacao?: number | null;
  pendentesUrgentes?: number | null;
}

interface ReservaAgenda {
  id: string;
  setorNome: string;
  // Só vem preenchido quando o setor solicitante é "Terceirizados" (regra em
  // empresaTerceirizada.ts, no shared) e a reserva é posterior à migration que criou a
  // coluna. Opcional aqui de propósito: enquanto a rota de agenda não devolver o campo (ou
  // para reservas antigas), a linha simplesmente não mostra a empresa em vez de quebrar.
  empresaTerceirizada?: string | null;
  solicitanteId: string;
  solicitanteNome: string;
  plataformaId: string;
  plataformaNome: string;
  plataformaCategoria: string;
  data: string;
  /** Último dia do período (migration 0029); igual a `data` numa reserva de um dia. */
  dataFim?: string;
  horaInicio: string;
  horaFim: string;
  motivo: string;
  prioridade: string;
  status: string;
  // Correção do fluxo de Checklist: resolvido pelo backend (template da plataforma OU
  // default da categoria) — nunca mais uma lista fixa de categorias no frontend.
  requerChecklist: boolean;
  checklistFinalizadoEm: string | null;
  checklistTodosConformes: boolean | null;
}

interface Agenda {
  hoje: ReservaAgenda[];
  proximas: ReservaAgenda[];
  // Solicitações do próprio usuário ainda sem decisão (fora da timeline operacional).
  minhasPendentes?: ReservaAgenda[];
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  categoria: string;
  status: string;
}

interface ItemDistribuicao {
  chave: string;
  quantidade: number;
}
interface UtilizacaoPlataforma {
  plataformaId: string;
  codigo: string;
  nome: string;
  taxaUtilizacao: number;
}
interface UtilizacaoResposta {
  plataformas: UtilizacaoPlataforma[];
}
interface RankingSetorItem {
  setorId: string;
  setorNome: string;
  corHex: string;
  totalReservas: number;
  taxaRejeicao: number;
}

export interface DashboardClientProps {
  usuarioId: string;
  usuarioNome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
}

function saudacao(): string {
  const hora = new Date().getHours();
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

function numeroSemana(data: Date): number {
  const d = new Date(Date.UTC(data.getFullYear(), data.getMonth(), data.getDate()));
  const diaSemana = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - diaSemana);
  const inicioAno = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - inicioAno.getTime()) / 86400000 + 1) / 7);
}

function eyebrowHero(): string {
  const agora = new Date();
  const semana = numeroSemana(agora);
  const texto = agora.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  return `${texto} · SEMANA ${semana}`.toUpperCase();
}

function formatarDataCurta(data: string): string {
  const [, mes, dia] = data.split("-");
  return `${dia}/${mes}`;
}

/* Reserva de vários dias: "05/10 08:00 → 12/10 17:00"; de um dia: "08:00–17:00". */
function rotuloHorario(r: { data: string; dataFim?: string; horaInicio: string; horaFim: string }): string {
  const dataFim = r.dataFim ?? r.data;
  if (dataFim === r.data) return `${r.horaInicio}–${r.horaFim}`;
  return `${formatarDataCurta(r.data)} ${r.horaInicio} → ${formatarDataCurta(dataFim)} ${r.horaFim}`;
}

/** "até 17:00" hoje; "até 12/10 17:00" quando termina em outro dia. */
function rotuloFim(r: { data: string; dataFim?: string; horaFim: string }, hoje: string): string {
  const dataFim = r.dataFim ?? r.data;
  return dataFim === hoje ? `até ${r.horaFim}` : `até ${formatarDataCurta(dataFim)} ${r.horaFim}`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function primeiroDiaMesesAtras(quantidade: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - quantidade);
  return d.toISOString().slice(0, 10);
}
function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}

function nomeCurto(nomeCompleto: string): string {
  const partes = nomeCompleto.trim().split(/\s+/);
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1][0]}.`;
}

function codigoSolicitacao(id: string): string {
  return `R-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function formatarAguardando(desde: string): string {
  const ms = Date.now() - new Date(desde).getTime();
  if (ms < 0) return "agora";
  const horas = ms / 3_600_000;
  if (horas < 1) return `${Math.max(1, Math.round(ms / 60_000))}min`;
  if (horas < 24) return `${Math.floor(horas)}h`;
  return `${Math.floor(horas / 24)}d`;
}

/* Régua da "Agenda em curso": janela DINÂMICA (calcularJanelaAgendaEmCurso, no shared) —
   do menor entre expediente/primeira reserva/agora−1h ao maior entre expediente/última
   reserva/agora+1h. Antes era fixa em 07:00–17:00 e escondia a operação da noite.
   Divisão pelo número de INTERVALOS (fim − início), não de rótulos: com N+1 rótulos, dividir
   por N+1 deslocava cada barra para a esquerda da própria hora. */
interface JanelaRegua {
  inicioHora: number;
  fimHora: number;
}

// Largura mínima de cada hora da régua: abaixo disso, dezenas de horas espremidas ficam
// ilegíveis — a régua passa a rolar na horizontal em vez de comprimir.
const PX_POR_HORA_REGUA = 72;

function posicaoNaRegua(horaStr: string, janela: JanelaRegua): number {
  const [h, m] = horaStr.split(":").map(Number);
  const fracao = (h + m / 60 - janela.inicioHora) / (janela.fimHora - janela.inicioHora);
  return Math.min(1, Math.max(0, fracao));
}

function minutosAgora(): number {
  const [h, m] = nowHHMM().split(":").map(Number);
  return h * 60 + m;
}

function paraMinutos(horaStr: string): number {
  const [h, m] = horaStr.split(":").map(Number);
  return h * 60 + m;
}

// Correção da Agenda em curso: altura de cada lane (barra + respiro vertical) e altura
// mínima (1 lane) do contêiner — usadas tanto para posicionar cada barra (top = lane *
// ALTURA_LANE) quanto para dimensionar o contêiner conforme a quantidade de lanes
// realmente usada naquele dia, em vez de uma altura fixa que sobrepunha reservas.
const ALTURA_LANE = 44;
const ALTURA_MINIMA_TIMELINE = 64;

const STATUS_PILL: Record<string, { label: string; classe: string }> = {
  concluida: { label: "Concluída", classe: "pillConcluida" },
  em_uso: { label: "Em Campo", classe: "pillEmUso" },
  agendada: { label: "Agendada", classe: "pillAgendada" },
  // Legado: reservas anteriores ao fluxo direto ainda podem carregar este status.
  // Solicitação aguardando aprovação — só aparece em "Minhas próximas", nunca na timeline.
  pendente: { label: "Aguardando aprovação", classe: "pillPendente" },
};

function StatusPill({ item }: { item: ReservaAgenda }) {
  const info = STATUS_PILL[item.status] ?? { label: item.status, classe: "pillAgendada" };
  return <span className={`${styles.pill} ${styles[info.classe]}`}>{info.label}</span>;
}

/* ---------- Composição dos painéis ----------
   Por que existe: os painéis da Central variam por perfil (Utilização só para
   gestor/admin, Ranking só para admin) e cada um tem altura própria, que depende dos DADOS
   (quantas reservas hoje, quantas plataformas). O layout antigo fixava duas pilhas
   (.mainColumn 2fr / .sideColumn 1fr) com `align-items: start`: a altura de cada pilha era a
   soma do que ela tinha dentro, então a pilha mais curta terminava cedo e deixava um vão
   proporcional à diferença entre as duas — e o Ranking, irmão de largura total, só começava
   depois da pilha mais alta. Nenhum ajuste de gap/altura resolve isso, porque o vão nasce de
   uma distribuição decidida sem olhar para o conteúdo.
   Aqui os painéis são uma lista montada ANTES do JSX (painel que não se aplica ao perfil
   simplesmente não entra) e a distribuição em colunas é calculada a partir dessa lista.
   Grid de linhas e multi-coluna CSS não servem: o primeiro alinha linhas entre colunas e o
   segundo só particiona em ordem contígua; nenhum dos dois enxerga a altura que cada painel
   vai ter. Estimamos a altura a partir da contagem de itens (dado que já temos) e escolhemos
   a partição que deixa as pilhas mais parecidas em altura. */

// Alturas aproximadas (px) das partes de um painel. NÃO são layout — o layout real é o do
// CSS —, servem só para comparar pilhas; um erro de alguns px apenas troca um painel de
// coluna em casos de empate.
const ALTURA_CABECALHO_PAINEL = 98;
const ALTURA_PADDING_CORPO = 40;
const ALTURA_RODAPE_PAINEL = 47;
const ALTURA_ESTADO_VAZIO = 61;
const ALTURA_LINHA_AGENDA = 70;
const ALTURA_LINHA_FROTA = 67;
const ALTURA_LINHA_UTILIZACAO = 46;
// Régua + margens da timeline (sem as lanes, que têm altura própria).
const ALTURA_FIXA_TIMELINE = 60;

// Espelha o `gap` de .composicao/.pilha no CSS.
const ESPACO_ENTRE_PAINEIS = 24;
const MAX_COLUNAS = 3;
// Menor largura que uma coluna SECUNDÁRIA pode ter: abaixo disso a linha da frota (nome +
// status) e a tabela de utilização passam a truncar o que é a informação principal.
const LARGURA_MIN_COLUNA = 380;
// A primeira coluna (onde cai a Agenda, o painel de timeline) recebe fração maior: a régua
// horária precisa de largura para os rótulos e para o texto das barras curtas.
const FRACAO_COLUNA_PRIMARIA = 1.3;
// Entre configurações de colunas com desperdício praticamente igual, prefere a com mais
// colunas (aproveita melhor telas largas).
const TOLERANCIA_DESPERDICIO = 0.04;

interface PainelDef {
  id: string;
  /** Altura estimada em px, sem o espaço entre painéis. */
  peso: number;
  /** Painel de tabela larga: ocupa a linha inteira abaixo das pilhas, em vez de disputar coluna. */
  largo?: boolean;
  conteudo: ReactNode;
}

function idTituloPainel(id: string): string {
  return `painel-${id}-titulo`;
}

/** Quantas colunas cabem na largura dada respeitando a largura mínima da coluna secundária. */
function colunasQueCabem(largura: number): number {
  for (let k = MAX_COLUNAS; k > 1; k -= 1) {
    const larguraSecundaria = (largura - ESPACO_ENTRE_PAINEIS * (k - 1)) / (k - 1 + FRACAO_COLUNA_PRIMARIA);
    if (larguraSecundaria >= LARGURA_MIN_COLUNA) return k;
  }
  return 1;
}

interface Distribuicao {
  /** Coluna (0-based) de cada painel, na ordem de entrada. */
  colunaDe: number[];
  colunas: number;
  /** Fração da área (colunas x altura da mais alta) que sobra vazia; 0 = colunas iguais. */
  desperdicio: number;
}

/* Enumeração exaustiva (a lista tem no máximo ~4 painéis empilháveis): testa toda
   atribuição painel→coluna e fica com a de MENOR altura da coluna mais alta. Só gera
   atribuições em "forma canônica" (a coluna nova só abre depois da anterior), o que elimina
   as espelhadas e mantém a coluna 0 sempre com o primeiro painel (a Agenda). */
function melhorDistribuicao(pesos: number[], maxColunas: number): Distribuicao {
  const total = pesos.reduce((soma, p) => soma + p, 0);
  const atual = new Array<number>(pesos.length).fill(0);
  const somas = new Array<number>(maxColunas).fill(0);
  let melhorAltura = Infinity;
  let melhor = atual.slice();
  let melhorUsadas = 1;

  const recorrer = (i: number, usadas: number) => {
    if (i === pesos.length) {
      const altura = Math.max(...somas);
      if (altura < melhorAltura) {
        melhorAltura = altura;
        melhor = atual.slice();
        melhorUsadas = usadas;
      }
      return;
    }
    const limite = Math.min(usadas + 1, maxColunas);
    for (let c = 0; c < limite; c += 1) {
      atual[i] = c;
      somas[c] += pesos[i];
      recorrer(i + 1, Math.max(usadas, c + 1));
      somas[c] -= pesos[i];
    }
  };
  recorrer(0, 0);

  return {
    colunaDe: melhor,
    colunas: melhorUsadas,
    desperdicio: melhorAltura > 0 ? 1 - total / (melhorUsadas * melhorAltura) : 0,
  };
}

/** Índices dos painéis agrupados por pilha, da esquerda para a direita. */
function comporPilhas(pesos: number[], colunasDisponiveis: number): number[][] {
  if (pesos.length === 0) return [];
  const limite = Math.min(colunasDisponiveis, pesos.length);
  if (limite <= 1) return [pesos.map((_, i) => i)];

  const candidatos: Distribuicao[] = [];
  for (let k = 2; k <= limite; k += 1) candidatos.push(melhorDistribuicao(pesos, k));
  const menorDesperdicio = Math.min(...candidatos.map((c) => c.desperdicio));
  const escolhido = candidatos
    .filter((c) => c.desperdicio <= menorDesperdicio + TOLERANCIA_DESPERDICIO)
    .sort((a, b) => b.colunas - a.colunas)[0];

  const pilhas: number[][] = Array.from({ length: escolhido.colunas }, () => []);
  escolhido.colunaDe.forEach((coluna, indice) => pilhas[coluna].push(indice));
  return pilhas;
}

function Composicao({ paineis }: { paineis: PainelDef[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Largura do próprio contêiner (não da janela): a sidebar expandida/recolhida muda a
  // área útil sem mudar a janela, e é a área útil que decide quantas colunas cabem.
  const [largura, setLargura] = useState(0);

  // Layout effect: mede antes da primeira pintura, para o usuário nunca ver a lista
  // empilhada numa coluna só e depois "pular" para várias. (Este componente só monta depois
  // do carregamento, então nunca roda no servidor.)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const medir = () => setLargura(Math.round(el.getBoundingClientRect().width));
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  const empilhaveis = paineis.filter((p) => !p.largo);
  const largos = paineis.filter((p) => p.largo);
  const pilhas = comporPilhas(
    empilhaveis.map((p) => p.peso + ESPACO_ENTRE_PAINEIS),
    colunasQueCabem(largura),
  );

  const gridTemplateColumns =
    pilhas.length > 1
      ? `minmax(0, ${FRACAO_COLUNA_PRIMARIA}fr) repeat(${pilhas.length - 1}, minmax(0, 1fr))`
      : undefined;

  function renderPainel(p: PainelDef, classeExtra?: string) {
    return (
      <section
        key={p.id}
        className={classeExtra ? `${styles.panel} ${classeExtra}` : styles.panel}
        data-painel={p.id}
        aria-labelledby={idTituloPainel(p.id)}
      >
        {p.conteudo}
      </section>
    );
  }

  return (
    <div
      ref={containerRef}
      className={styles.composicao}
      style={gridTemplateColumns ? ({ gridTemplateColumns } as CSSProperties) : undefined}
      data-paineis={paineis.length}
      data-colunas={pilhas.length}
    >
      {pilhas.map((indices, i) => (
        <div key={i} className={styles.pilha} data-pilha={i + 1}>
          {indices.map((indice) => renderPainel(empilhaveis[indice]))}
        </div>
      ))}
      {largos.map((p) => renderPainel(p, styles.painelLargo))}
    </div>
  );
}

/* Fundo do hero: um feixe de curvas finas que atravessa a transição claro → grafite.
   Geradas aqui (e não como imagem) para escalar sem serrilhar e não pesar no carregamento.
   O traço usa um gradiente: invisível no lado claro, quente na transição e claro sobre o
   grafite — a malha só "aparece" onde o fundo escurece. Puramente decorativo. */
const HERO_FIOS = Array.from({ length: 56 }, (_, i) => {
  const t = i / 55;
  const d =
    `M 380 ${(190 + t * 70).toFixed(1)} ` +
    `C 700 ${(120 + t * 150).toFixed(1)}, 900 ${(350 - t * 30).toFixed(1)}, 1140 ${(262 - t * 64).toFixed(1)} ` +
    `S 1480 ${(40 + t * 40).toFixed(1)}, 1680 ${(-20 + t * 110).toFixed(1)}`;
  return { d, opacidade: 0.35 + 0.65 * Math.sin(Math.PI * t) };
});

function HeroFundo() {
  return (
    <svg
      className={styles.heroArte}
      viewBox="0 0 1600 360"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="heroFioTraco" gradientUnits="userSpaceOnUse" x1="380" y1="0" x2="1600" y2="0">
          <stop offset="0" stopColor="oklch(0.3 0.01 65)" stopOpacity="0" />
          <stop offset="0.3" stopColor="oklch(0.3 0.01 65)" stopOpacity="0.07" />
          <stop offset="0.56" stopColor="oklch(0.86 0.09 75)" stopOpacity="0.55" />
          <stop offset="0.72" stopColor="oklch(0.94 0.04 80)" stopOpacity="0.32" />
          <stop offset="1" stopColor="oklch(0.96 0.005 80)" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#heroFioTraco)" strokeWidth="0.7">
        {HERO_FIOS.map((f, i) => (
          <path key={i} d={f.d} strokeOpacity={f.opacidade} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}

export function DashboardClient({ usuarioId, usuarioNome, perfil }: DashboardClientProps) {
  const ehAprovador = perfil === "admin" || perfil === "gestor_setor";
  const periodo = useMemo(() => ({ dateFrom: primeiroDiaMesesAtras(5), dateTo: hoje() }), []);

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [plataformas, setPlataformas] = useState<Plataforma[]>([]);
  const [utilizacao, setUtilizacao] = useState<UtilizacaoResposta | null>(null);
  const [ranking, setRanking] = useState<RankingSetorItem[] | null>(null);
  const [ultimaSincronizacao, setUltimaSincronizacao] = useState<string>("");
  // Expediente configurado: só entra no cálculo da janela da régua. Falha aqui não derruba o
  // painel — a janela passa a considerar apenas reservas e horário atual.
  const [expediente, setExpediente] = useState<{ inicio: string; fim: string } | null>(null);
  useEffect(() => {
    apiFetch<{ horarioExpedienteInicio: string; horarioExpedienteFim: string }>("/api/v1/configuracoes/regras-reserva")
      .then((regras) => setExpediente({ inicio: regras.horarioExpedienteInicio, fim: regras.horarioExpedienteFim }))
      .catch(() => setExpediente(null));
  }, []);

  // `carregar` guardado em ref para que o efeito de SSE (abaixo) possa dispará-lo sem
  // recriar a assinatura do canal a cada render.
  const recarregarRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function carregar(primeiraVez: boolean) {
      if (primeiraVez) setCarregando(true);
      try {
        const query = `dateFrom=${periodo.dateFrom}&dateTo=${periodo.dateTo}`;
        /* A fila de aprovações e os checklists pendentes saíram da carga junto com o
           fluxo que os alimentava. O que sobrou responde às perguntas que o painel ainda
           precisa responder: o que está acontecendo hoje, qual equipamento está livre e
           como a frota vem sendo usada. */
        const promessas: Promise<unknown>[] = [
          apiFetch<Kpis>("/api/v1/dashboard/kpis"),
          apiFetch<Agenda>("/api/v1/dashboard/agenda"),
          apiFetch<Plataforma[]>("/api/v1/plataformas"),
        ];
        if (ehAprovador) {
          promessas.push(apiFetch<UtilizacaoResposta>(`/api/v1/relatorios/utilizacao?${query}`));
        }
        if (perfil === "admin") {
          promessas.push(apiFetch<{ setores: RankingSetorItem[] }>(`/api/v1/relatorios/ranking-setores?${query}`));
        }
        const resultados = await Promise.all(promessas);
        if (cancelado) return;

        setKpis(resultados[0] as Kpis);
        setAgenda(resultados[1] as Agenda);
        setPlataformas(resultados[2] as Plataforma[]);
        let proximoIndice = 3;
        if (ehAprovador) {
          setUtilizacao(resultados[proximoIndice] as UtilizacaoResposta);
          proximoIndice += 1;
        }
        if (perfil === "admin") {
          setRanking((resultados[proximoIndice] as { setores: RankingSetorItem[] }).setores);
        }
        setUltimaSincronizacao(nowHHMM());
        setErro(null);
      } catch (err) {
        if (!cancelado) setErro(err instanceof Error ? err.message : "Erro ao carregar o dashboard.");
      } finally {
        if (!cancelado && primeiraVez) setCarregando(false);
      }
    }

    carregar(true);
    recarregarRef.current = () => carregar(false);

    // O dashboard recarregava as 8 rotas a cada 60s incondicionalmente — mesmo com a aba
    // em segundo plano e mesmo sem nada ter mudado no sistema. Como o app já mantém um
    // canal SSE aberto (o mesmo do sino de notificações), a atualização passa a ser
    // dirigida por evento: recarrega quando algo realmente muda (ver efeito abaixo) e o
    // intervalo vira só uma rede de segurança, bem mais espaçada, para o caso de o SSE
    // estar indisponível (proxy corporativo bloqueando streaming).
    const intervalo = setInterval(() => {
      // `document.hidden`: uma aba de dashboard esquecida em segundo plano fazia 8
      // requisições por minuto indefinidamente, por usuário.
      if (!document.hidden) carregar(false);
    }, 180_000);

    // Ao voltar para a aba, sincroniza na hora em vez de exibir dados possivelmente
    // velhos até o próximo tique do intervalo.
    function aoVoltarParaAba() {
      if (!document.hidden) carregar(false);
    }
    document.addEventListener("visibilitychange", aoVoltarParaAba);

    return () => {
      cancelado = true;
      recarregarRef.current = null;
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", aoVoltarParaAba);
    };
  }, [ehAprovador, perfil, periodo]);

  // Atualização em tempo real: qualquer mudança de reserva ou de status de plataforma
  // publicada pelo backend refaz a carga. Sem isto, aprovar uma reserva em outra aba (ou
  // outro usuário concluir um uso) só refletia aqui no próximo ciclo do intervalo.
  const timerEventoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEventosSSE({
    onEvento: () => {
      // Agrupa rajadas de eventos numa única recarga: criar uma série recorrente publica
      // até 12 eventos seguidos, e cada recarga custa 8 requisições.
      if (timerEventoRef.current) clearTimeout(timerEventoRef.current);
      timerEventoRef.current = setTimeout(() => recarregarRef.current?.(), 600);
    },
  });
  useEffect(() => () => {
    if (timerEventoRef.current) clearTimeout(timerEventoRef.current);
  }, []);

  const plataformasPorId = useMemo(() => new Map(plataformas.map((p) => [p.id, p])), [plataformas]);

  const emUsoAgora = useMemo(() => agenda?.hoje.find((r) => r.status === "em_uso") ?? null, [agenda]);
  // Recorte de HOJE de cada reserva (migration 0029): uma reserva que começou antes ocupa a
  // régua desde 00:00, e uma que continua amanhã vai até 24:00 — a barra é a mesma reserva.
  const hojeIso = hojeBrasilia();
  const reservasHojeNoDia = useMemo(
    () =>
      (agenda?.hoje ?? []).map((r) => ({
        ...r,
        horaInicioDia: r.data < hojeIso ? "00:00" : r.horaInicio,
        horaFimDia: (r.dataFim ?? r.data) > hojeIso ? "24:00" : r.horaFim,
      })),
    [agenda, hojeIso]
  );

  const manutencaoPlataformas = useMemo(() => plataformas.filter((p) => p.status === "manutencao"), [plataformas]);

  /* O contexto do hero deixou de contar "pontos que exigem sua decisão": não existe mais
     decisão a tomar. Passa a dizer o que está acontecendo agora — que é a pergunta que o
     painel responde no fluxo novo. */
  const contextoHero = useMemo(() => {
    if (!kpis) return "";
    if (kpis.emUso > 0) {
      return kpis.emUso === 1
        ? "1 plataforma em operação neste momento."
        : `${kpis.emUso} plataformas em operação neste momento.`;
    }
    return kpis.reservasHoje > 0
      ? `${kpis.reservasHoje === 1 ? "1 reserva agendada" : `${kpis.reservasHoje} reservas agendadas`} para hoje.`
      : "Nenhuma reserva agendada para hoje.";
  }, [kpis]);

  const minhasProximas = useMemo(() => {
    if (!agenda) return [];
    // Solicitações próprias aguardando aprovação entram aqui (com o selo "Aguardando
    // aprovação"), para o colaborador acompanhar — nunca na timeline operacional.
    return [...agenda.hoje, ...agenda.proximas, ...(agenda.minhasPendentes ?? [])]
      .filter((r) => r.solicitanteId === usuarioId)
      .sort((a, b) => `${a.data} ${a.horaInicio}`.localeCompare(`${b.data} ${b.horaInicio}`));
  }, [agenda, usuarioId]);

  const utilizacaoOrdenada = useMemo(() => {
    if (!utilizacao) return [];
    return [...utilizacao.plataformas].sort((a, b) => b.taxaUtilizacao - a.taxaUtilizacao);
  }, [utilizacao]);
  const mediaUtilizacao = useMemo(() => {
    if (utilizacaoOrdenada.length === 0) return 0;
    return Math.round((utilizacaoOrdenada.reduce((s, p) => s + p.taxaUtilizacao, 0) / utilizacaoOrdenada.length) * 10) / 10;
  }, [utilizacaoOrdenada]);

  const maiorRankingSetor = useMemo(() => {
    if (!ranking || ranking.length === 0) return 0;
    return Math.max(...ranking.map((s) => s.totalReservas));
  }, [ranking]);

  // Recalculado a cada sincronização (`ultimaSincronizacao` serve de "tique"): com
  // dependência vazia o marcador AGORA ficava congelado na hora em que a página abriu,
  // mesmo com o painel recarregando por SSE.
  const janelaRegua = useMemo<JanelaRegua>(
    () =>
      calcularJanelaAgendaEmCurso({
        agoraMin: minutosAgora(),
        intervalos: reservasHojeNoDia.map((r) => ({ horaInicio: r.horaInicioDia, horaFim: r.horaFimDia })),
        expediente,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reservasHojeNoDia, expediente, ultimaSincronizacao]
  );
  const horasRegua = useMemo(
    () =>
      Array.from({ length: janelaRegua.fimHora - janelaRegua.inicioHora + 1 }, (_, i) => janelaRegua.inicioHora + i),
    [janelaRegua]
  );
  const agoraFracaoRegua = useMemo(() => {
    const agora = minutosAgora() / 60;
    if (agora < janelaRegua.inicioHora || agora >= janelaRegua.fimHora) return null;
    return (agora - janelaRegua.inicioHora) / (janelaRegua.fimHora - janelaRegua.inicioHora);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [janelaRegua, ultimaSincronizacao]);

  // Ao abrir (e só na primeira carga — uma revalidação por SSE não pode arrancar o scroll da
  // mão do usuário), a régua rola até perto do horário atual: às 17h ela não começa em 07:00.
  const reguaScrollRef = useRef<HTMLDivElement>(null);
  const reguaPosicionadaRef = useRef(false);
  useLayoutEffect(() => {
    const el = reguaScrollRef.current;
    if (!el || reguaPosicionadaRef.current || agoraFracaoRegua === null) return;
    if (el.scrollWidth <= el.clientWidth) return;
    reguaPosicionadaRef.current = true;
    el.scrollLeft = Math.max(0, agoraFracaoRegua * el.scrollWidth - el.clientWidth / 3);
  }, [agoraFracaoRegua, agenda]);

  // Correção da Agenda em curso: reservas que se sobrepõem no horário ganham lanes
  // (linhas) diferentes em vez de disputar a mesma faixa — ver calcularLanes em
  // @plataformares/shared (algoritmo puro, testado por apps/api).
  const reservasDaReguaComLane = useMemo(() => {
    // A janela é derivada das próprias reservas do dia: nenhuma fica fora da régua.
    return calcularLanes(reservasHojeNoDia, (r) => ({
      inicioMinutos: paraMinutos(r.horaInicioDia),
      fimMinutos: paraMinutos(r.horaFimDia),
    }));
  }, [reservasHojeNoDia]);
  const numeroDeLanes = Math.max(1, contarLanes(reservasDaReguaComLane));
  const alturaTimeline = Math.max(ALTURA_MINIMA_TIMELINE, numeroDeLanes * ALTURA_LANE);

  if (carregando) {
    return (
      <section>
        <div className={styles.loading}>Carregando dashboard...</div>
      </section>
    );
  }

  /* Lista de painéis realmente renderizáveis para ESTE perfil, montada antes do JSX: um
     painel que não se aplica não entra na lista, então não deixa contêiner nem coluna
     reservada. A ordem aqui é a prioridade de leitura — é ela que vale no celular, onde
     tudo vira uma pilha só. */
  const reservasDeHoje = agenda?.hoje ?? [];
  const paineis: PainelDef[] = [
    {
      id: "agenda",
      peso:
        ALTURA_CABECALHO_PAINEL +
        ALTURA_PADDING_CORPO +
        (reservasDeHoje.length > 0 ? ALTURA_FIXA_TIMELINE + alturaTimeline : ALTURA_ESTADO_VAZIO) +
        reservasDeHoje.length * ALTURA_LINHA_AGENDA,
      conteudo: (
        <>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Operações · Hoje</div>
              <h2 id={idTituloPainel("agenda")} className={styles.panelTitle}>Agenda em curso</h2>
            </div>
            <div className={styles.legend}>
              <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendEmUso}`} />Em uso</span>
              <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.legendConcluida}`} />Concluída</span>
            </div>
          </div>
          <div className={styles.panelBody}>
            {/* Painel vazio não precisa da régua horária inteira — o estado
                "Nenhuma reserva para hoje" já é a informação, mostrar uma linha do
                tempo vazia por cima só empurrava o card pra baixo à toa. */}
            {/* Pendências de aprovação ficam à parte: uma linha discreta com o atalho para a
                fila, sem misturar solicitações não confirmadas à agenda operacional. */}
            {ehAprovador && (kpis?.pendentesAprovacao ?? 0) > 0 && (
              <Link href="/reservas?status=pendente" className={styles.pendenciasLinha}>
                <span>
                  <strong>{kpis!.pendentesAprovacao}</strong>{" "}
                  {kpis!.pendentesAprovacao === 1 ? "solicitação aguardando aprovação" : "solicitações aguardando aprovação"}
                  {(kpis?.pendentesUrgentes ?? 0) > 0 && (
                    <span className={styles.pendenciasUrgentes}>
                      {kpis!.pendentesUrgentes} {kpis!.pendentesUrgentes === 1 ? "urgente" : "urgentes"}
                    </span>
                  )}
                </span>
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            )}

            {reservasDeHoje.length > 0 ? (
              // A régua rola na horizontal quando a janela do dia não cabe (≥72px por hora):
              // dezenas de horas nunca são comprimidas até ficarem ilegíveis.
              <div className={styles.timelineScroll} ref={reguaScrollRef}>
              <div
                className={styles.timeline}
                style={{ minWidth: `${(janelaRegua.fimHora - janelaRegua.inicioHora) * PX_POR_HORA_REGUA}px` }}
              >
                {/* AGORA span da régua até o fundo das lanes — fica fora de .timelineLanes
                    de propósito (como irmão da régua) para a linha vertical atravessar as
                    duas sem precisar duplicar o cálculo de posição em dois lugares. O
                    espaço reservado no topo de .timeline (ver CSS) é onde o rótulo "AGORA"
                    fica, sem colidir com os números da régua logo abaixo. */}
                {agoraFracaoRegua !== null && (
                  <div className={styles.nowMarker} style={{ left: `${agoraFracaoRegua * 100}%` }}>
                    <span className={styles.nowLabel}>AGORA</span>
                  </div>
                )}
                <div className={styles.timelineRuler}>
                  {horasRegua.map((h) => (
                    // .timelineTick nunca existiu no CSS — o className resolvia para
                    // `undefined` e ia parar no DOM. Os rotulos da regua sao estilizados
                    // pelo proprio .timelineRuler (fonte/mono/cor) e pela regra
                    // `.timelineRuler > span:nth-child(even)` da container query.
                    <span key={h}>{String(h).padStart(2, "0")}:00</span>
                  ))}
                </div>
                <div className={styles.timelineLane} style={{ height: `${alturaTimeline}px` }}>
                  {reservasDaReguaComLane.map(({ item: r, lane }) => {
                    const left = posicaoNaRegua(r.horaInicioDia, janelaRegua);
                    const right = posicaoNaRegua(r.horaFimDia, janelaRegua);
                    const largura = Math.max(0.02, right - left);
                    const classeCor =
                      r.status === "em_uso"
                        ? styles.barEmUso
                        : r.status === "concluida"
                          ? styles.barConcluida
                          : styles.barAgendada;
                    return (
                      <div
                        key={r.id}
                        className={`${styles.timelineBar} ${classeCor}`}
                        style={{ left: `${left * 100}%`, width: `${largura * 100}%`, top: `${lane * ALTURA_LANE}px` }}
                        title={`${r.plataformaNome} — ${rotuloHorario(r)}`}
                      >
                        <span className={styles.timelineBarTime}>{rotuloHorario(r)}</span>
                        <span className={styles.timelineBarLabel}>{r.motivo || r.plataformaNome}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              </div>
            ) : (
              <div className={styles.empty}>Nenhuma reserva para hoje.</div>
            )}

            <div className={styles.agendaList}>
              {reservasDeHoje.map((r) => (
                <div key={r.id} className={styles.agendaRow}>
                  <span className={styles.agendaTime}>{rotuloHorario(r)}</span>
                  <div className={styles.agendaInfo}>
                    <span className={styles.agendaTitle}>{r.motivo || r.plataformaNome}</span>
                    {/* Solicitante saiu da linha secundária: numa agenda do dia, o que
                        identifica a reserva é o equipamento e o setor — o nome de quem
                        pediu está no detalhe, e aqui só empurrava o texto para o corte.
                        Reserva de setor terceirizado acrescenta a empresa ("Setor ·
                        Empresa"): é ela que a portaria e a operação reconhecem no campo. */}
                    <span className={styles.agendaMeta} title={r.solicitanteNome}>
                      {plataformasPorId.get(r.plataformaId)?.codigo ?? r.plataformaNome} · {r.setorNome}
                      {r.empresaTerceirizada?.trim() ? ` · ${r.empresaTerceirizada.trim()}` : ""}
                    </span>
                  </div>
                  <StatusPill item={r} />
                </div>
              ))}
            </div>
          </div>
        </>
      ),
    },
    /* O painel "Ação Necessária / Fila de aprovações" foi removido: sem aprovação,
       ele só saberia exibir "0 pendentes" indefinidamente. "Minhas próximas reservas"
       era o ramo alternativo do mesmo ternário e passa a valer para todos os perfis —
       é informação útil para quem aprova tanto quanto para quem solicita. */
    {
      id: "minhas-reservas",
      peso:
        ALTURA_CABECALHO_PAINEL +
        ALTURA_PADDING_CORPO +
        (minhasProximas.length === 0 ? ALTURA_ESTADO_VAZIO : minhasProximas.length * ALTURA_LINHA_AGENDA),
      conteudo: (
        <>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Agenda</div>
              <h2 id={idTituloPainel("minhas-reservas")} className={styles.panelTitle}>Minhas próximas reservas</h2>
            </div>
          </div>
          <div className={styles.panelBody}>
            {minhasProximas.length === 0 ? (
              <div className={styles.empty}>Você não tem reservas nos próximos dias.</div>
            ) : (
              <div className={styles.agendaList}>
                {minhasProximas.map((r) => (
                  <div key={r.id} className={styles.agendaRow}>
                    <span className={styles.agendaTime}>
                      {formatarDataCurta(r.data)} {r.horaInicio}
                      {(r.dataFim ?? r.data) !== r.data && ` → ${formatarDataCurta(r.dataFim!)}`}
                    </span>
                    <div className={styles.agendaInfo}>
                      <span className={styles.agendaTitle}>{r.plataformaNome}</span>
                      <span className={styles.agendaMeta}>{r.motivo}</span>
                    </div>
                    <StatusPill item={r} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ),
    },
    /* O gráfico "Reservas x Concluídas" era derivado de /relatorios/sla-aprovacao —
       uma métrica do fluxo de aprovação. Sem aprovação, a série "concluídas" seria
       apenas uma fração fixa da série "reservas": um gráfico que só repete a mesma
       curva duas vezes. Removido em vez de mantido zerado. */
    {
      id: "frota",
      peso:
        ALTURA_CABECALHO_PAINEL +
        ALTURA_PADDING_CORPO +
        (plataformas.length === 0 ? ALTURA_ESTADO_VAZIO : plataformas.length * ALTURA_LINHA_FROTA) +
        ALTURA_RODAPE_PAINEL,
      conteudo: (
        <>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Frota</div>
              <h2 id={idTituloPainel("frota")} className={styles.panelTitle}>Status em tempo real</h2>
            </div>
          </div>
          <div className={styles.panelBody}>
            {plataformas.length === 0 ? (
              <div className={styles.empty}>Nenhuma plataforma cadastrada.</div>
            ) : (
              <div className={styles.fleetList}>
                {/* Cada linha era cinco níveis competindo: código, nome, categoria ·
                    local, rótulo de status e um detalhe. Ficaram três — nome (o
                    protagonista), uma linha secundária "código · local" e o status. O
                    detalhe só sobrevive quando ACRESCENTA algo ao rótulo: "até 15:30" sob
                    "Em Uso" muda o que o usuário faz; "Indisponível por manutenção" sob
                    "Em Manutenção" era a mesma frase duas vezes. */}
                {plataformas.map((p) => {
                  const emUso = agenda?.hoje.find((r) => r.plataformaId === p.id && r.status === "em_uso");
                  const proxima = agenda?.hoje
                    .filter(
                      (r) =>
                        r.plataformaId === p.id &&
                        (r.status === "agendada" || r.status === "pendente") &&
                        r.data === hojeIso &&
                        r.horaInicio > nowHHMM()
                    )
                    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))[0];
                  let statusLabel = "Disponível";
                  let detalhe: string | null = null;
                  let dotClasse = styles.fleetDotDisponivel;
                  let corClasse = styles.fleetCorDisponivel;
                  if (p.status === "reservada") {
                    statusLabel = "Em Uso";
                    dotClasse = styles.fleetDotEmUso;
                    corClasse = styles.fleetCorEmUso;
                    detalhe = emUso ? rotuloFim(emUso, hojeIso) : null;
                  } else if (p.status === "manutencao") {
                    statusLabel = "Em Manutenção";
                    dotClasse = styles.fleetDotManutencao;
                    corClasse = styles.fleetCorManutencao;
                  } else if (p.status === "inativa") {
                    statusLabel = "Inativa";
                    dotClasse = styles.fleetDotInativa;
                    corClasse = styles.fleetCorInativa;
                  } else if (proxima) {
                    detalhe = `livre até ${proxima.horaInicio}`;
                  }
                  return (
                    <div key={p.id} className={styles.fleetRow}>
                      <span className={`${styles.fleetDot} ${dotClasse}`} aria-hidden="true" />
                      <div className={styles.fleetInfo}>
                        {/* Nome longo trunca; categoria e nome completo ficam no title em
                            vez de forçarem uma terceira linha na coluna estreita. */}
                        <span
                          className={styles.fleetName}
                          title={`${p.nome} · ${CATEGORIA_LABEL[p.categoria] ?? p.categoria}`}
                        >
                          {p.nome}
                        </span>
                        <span className={styles.fleetMeta}>
                          {p.codigo}
                          {p.localizacao ? ` · ${p.localizacao}` : ""}
                        </span>
                      </div>
                      <div className={styles.fleetStatus}>
                        <span className={`${styles.fleetStatusLabel} ${corClasse}`}>{statusLabel}</span>
                        {detalhe && <span className={styles.fleetDetail}>{detalhe}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className={styles.panelFooter}>
            <span>Última sincronização: {ultimaSincronizacao}</span>
            <Link href="/plataformas" className={styles.footerLink}>
              Ver frota completa <ArrowUpRight size={13} strokeWidth={1.75} />
            </Link>
          </div>
        </>
      ),
    },
    /* O painel de conformidade NR-18/NR-35 saiu: ele acompanhava o checklist como
       etapa da reserva, e o checklist deixou de fazer parte desse fluxo. As normas do
       equipamento continuam visíveis na Frota, onde são atributo do ativo. */
  ];

  if (ehAprovador) {
    paineis.push({
      id: "utilizacao",
      peso:
        ALTURA_CABECALHO_PAINEL +
        ALTURA_PADDING_CORPO +
        (utilizacaoOrdenada.length === 0
          ? ALTURA_ESTADO_VAZIO
          : utilizacaoOrdenada.length * ALTURA_LINHA_UTILIZACAO + ALTURA_RODAPE_PAINEL),
      conteudo: (
        <>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Frota · 30 dias</div>
              <h2 id={idTituloPainel("utilizacao")} className={styles.panelTitle}>Utilização por unidade</h2>
            </div>
          </div>
          <div className={styles.panelBody}>
            {utilizacaoOrdenada.length === 0 ? (
              <div className={styles.empty}>Sem dados no período.</div>
            ) : (
              <div className={styles.utilList}>
                {utilizacaoOrdenada.map((p) => {
                  const corClasse = p.taxaUtilizacao > 70 ? styles.utilBarAlta : p.taxaUtilizacao > 40 ? styles.utilBarMedia : styles.utilBarBaixa;
                  return (
                    <div key={p.plataformaId} className={styles.utilRow}>
                      <div className={styles.utilLabelRow}>
                        <span className={styles.tableMono}>{p.codigo}</span>
                        <span className={styles.tableMono}>{p.taxaUtilizacao}%</span>
                      </div>
                      <div className={styles.utilTrack}>
                        <div className={`${styles.utilFill} ${corClasse}`} style={{ width: `${Math.min(100, p.taxaUtilizacao)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {utilizacaoOrdenada.length > 0 && (
            <div className={styles.panelFooter}>
              <span>Amostra · {utilizacaoOrdenada.length} plataformas</span>
              <span>Média · {mediaUtilizacao}%</span>
            </div>
          )}
        </>
      ),
    });
  }

  if (perfil === "admin") {
    paineis.push({
      id: "ranking",
      // Tabela de 4 colunas: fica numa faixa de largura total abaixo das pilhas (ver
      // Composicao) em vez de espremida numa coluna estreita.
      largo: true,
      peso: 0,
      conteudo: (
        <>
          <div className={styles.panelHeader}>
            <div>
              <div className={styles.panelEyebrow}>Consumo · Período</div>
              <h2 id={idTituloPainel("ranking")} className={styles.panelTitle}>Ranking de setores</h2>
            </div>
            <Link href="/relatorios" className={styles.footerLink}>
              Ver relatório completo <ArrowUpRight size={13} strokeWidth={1.75} />
            </Link>
          </div>
          <div className={styles.tableWrap}>
            {!ranking || ranking.length === 0 ? (
              <div className={styles.empty}>Nenhuma reserva no período.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Setor</th>
                    <th>Distribuição</th>
                    <th>Reservas</th>
                    <th>Rejeição</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((s) => (
                    <tr key={s.setorId}>
                      <td>{s.setorNome}</td>
                      <td className={styles.distribuicaoCell}>
                        <span className={styles.distribuicaoTrack}>
                          <span
                            className={styles.distribuicaoFill}
                            style={{ width: maiorRankingSetor > 0 ? `${(s.totalReservas / maiorRankingSetor) * 100}%` : "0%" }}
                          />
                        </span>
                      </td>
                      <td className={styles.tableMono}>{s.totalReservas}</td>
                      <td className={`${styles.tableMono} ${s.taxaRejeicao > 0 ? styles.tableHazard : ""}`}>{s.taxaRejeicao}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ),
    });
  }

  return (
    <>
      {/* Hero full-bleed: ocupa a área útil inteira (da sidebar à borda direita) e sobe por
          baixo da topbar, que fica transparente enquanto a página está no topo (Topbar
          sobreHero). O conteúdo interno segue a mesma largura máxima de .page. */}
      <div className={styles.hero}>
        <HeroFundo />
        <div className={styles.heroInner}>
          <div className={styles.heroTexto}>
            <div className={styles.eyebrow}>{eyebrowHero()}</div>
            <h1 className={styles.h1}>
              {saudacao()}, {usuarioNome.split(" ")[0]}.
              <em>{contextoHero}</em>
            </h1>
          </div>
          {/* Uma ação dominante só. "Abrir fila de aprovações" saiu junto com a fila; o
              botão de relatórios deixou de prometer um "briefing" (que nunca existiu como
              artefato) e passa a dizer para onde leva. */}
          <div className={styles.heroActions}>
            <Link href="/relatorios" className={styles.btnOutline}>
              Ver relatório
            </Link>
            <Link href="/reservas" className={styles.btnSolid}>
              {ehAprovador ? "Ver reservas" : "Minhas reservas"}
              <ArrowRight size={15} strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>

      <section className={styles.page} data-perfil={perfil}>
        {erro && (
          <div className={styles.error} role="alert">
            {erro}
          </div>
        )}

        {/* KPI = rótulo, número e UMA linha de contexto. Antes cada célula carregava duas
            linhas auxiliares (sub + trend), e seis células somavam doze fragmentos de texto
            disputando atenção com os próprios números — que são o motivo da faixa existir.
            A segunda linha só reaparece quando é exceção (aprovações atrasadas), em hazard. */}
        {kpis && (
          <div className={styles.kpiStrip}>
            <Link href="/plataformas" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Frota Total</span>
              <span className={styles.kpiValue}>{kpis.totalPlataformas}</span>
              <span className={styles.kpiSub}>
                {kpis.manutencao > 0 ? `${kpis.manutencao} em manutenção` : "todas operacionais"}
              </span>
            </Link>
            <Link href="/plataformas" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Disponíveis Agora</span>
              <span className={styles.kpiValue}>{kpis.disponiveis}</span>
              <span className={styles.kpiSub}>
                de {kpis.totalPlataformas}
                {kpis.totalPlataformas > 0 ? ` · ${Math.round((kpis.disponiveis / kpis.totalPlataformas) * 100)}%` : ""}
              </span>
            </Link>
            <Link href="/plataformas" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Em Operação</span>
              <span className={styles.kpiValue}>{kpis.emUso}</span>
              <span className={styles.kpiSub}>
                {emUsoAgora
                  ? `${plataformasPorId.get(emUsoAgora.plataformaId)?.codigo ?? emUsoAgora.plataformaNome} · ${rotuloFim(emUsoAgora, hojeIso)}`
                  : "nenhuma em uso"}
              </span>
            </Link>
            <Link href="/plataformas" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Em Manutenção</span>
              <span className={styles.kpiValue}>{kpis.manutencao}</span>
              {/* Os códigos das plataformas paradas vão para o title: numa célula estreita
                  eles truncavam no meio da sigla e não diziam mais nada. */}
              <span className={styles.kpiSub} title={manutencaoPlataformas.map((p) => p.nome).join(" · ") || undefined}>
                {manutencaoPlataformas.map((p) => p.codigo).join(" · ") || "nenhuma parada"}
              </span>
            </Link>
            {/* "Aprovações Pendentes" e "Checklists NR" mediam um fluxo que não existe
                mais — ficariam zerados para sempre. No lugar entram as duas perguntas que o
                painel ainda precisa responder: o que está agendado e o que deu errado.
                Cor própria (âmbar) — antes reusava o azul de "Em Operação", dois KPIs
                distintos não deveriam compartilhar o mesmo indicador. */}
            <Link href="/reservas" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Reservas Hoje</span>
              <span className={styles.kpiValue}>{kpis.reservasHoje}</span>
              <span className={styles.kpiSub}>{kpis.reservasProximos7Dias} nos próx. 7 dias</span>
            </Link>
            <Link href="/nao-conformidades" className={styles.kpiCell}>
              <span className={styles.kpiLabel}>Não Conformidades</span>
              <span className={styles.kpiValue}>{kpis.naoConformidadesRecentes}</span>
              {/* "registradas nos últimos 30 dias" truncava em "registradas nos últi…" na
                  célula de seis colunas; o rótulo já diz o que é, sobra só o período. */}
              <span className={styles.kpiSub}>nos últimos 30 dias</span>
            </Link>
          </div>
        )}

        <Composicao paineis={paineis} />
      </section>
    </>
  );
}
