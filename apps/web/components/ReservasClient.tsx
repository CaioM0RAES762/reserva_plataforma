"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarPlus, MapPin, Search, TriangleAlert } from "lucide-react";
import { ULTIMO_MINUTO_RESERVAVEL, minutosParaHora } from "@plataformares/shared";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { invalidarDisponibilidade } from "../lib/useDisponibilidade";
import { idsDeUsuarioIguais } from "../lib/disponibilidadeOwnership";
import { useEventosSSE } from "../lib/useEventosSSE";
import { DisponibilidadeTimeline, type SelecaoHorario } from "./DisponibilidadeTimeline";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { CampoFiltro, FiltrosAvancados } from "./FiltrosAvancados";
import { Paginacao } from "./Paginacao";
import { ReservaModal, type ReservaFormValues, type ReservaValoresIniciais } from "./ReservaModal";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

type Reserva = ReservaDetalhe;

interface ReservasClientProps {
  solicitanteNome: string;
  setorNome: string | null;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
  // Corrigir/melhorar Reservas: comparado ao `solicitanteId` de cada linha para
  // destacar "minhas reservas" — sempre por id, nunca por nome (dois usuários podem
  // ter nomes parecidos/iguais).
  usuarioId: string;
  /** Telefone do perfil (GET /conta) — repassado ao ReservaModal para pré-preencher o
   *  contato automaticamente. */
  telefonePerfil?: string | null;
}

const POR_PAGINA = 50;

// Preferência (por navegador) de manter a seção "Disponibilidade" recolhida. Só conveniência
// de leitura: a tela funciona igual sem ela (modo privado, storage bloqueado).
const CHAVE_DISPONIBILIDADE_RECOLHIDA = "reservas.disponibilidade.recolhida";

// Filtros rápidos: os mesmos status do domínio, na ordem do fluxo operacional. Substituem
// a combobox de status — um clique em vez de abrir a lista e escolher.
const FILTROS_RAPIDOS: Array<{ chave: string; label: string }> = [
  { chave: "", label: "Todas" },
  { chave: "em_uso", label: "Em uso" },
  { chave: "agendada", label: "Agendadas" },
  { chave: "pendente", label: "Pendentes" },
  { chave: "concluida", label: "Concluídas" },
  { chave: "cancelada", label: "Canceladas" },
];

// Corrigir/melhorar Reservas: filtro de período substitui o antigo campo único "Data
// específica" — a tela agora sempre opera sobre um intervalo real (dateFrom/dateTo, já
// suportado por GET /reservas), nunca "todas as datas de uma vez", que é o que fazia
// reservas de 2027 aparecerem misturadas com as da semana atual.
type AtalhoPeriodo = "hoje" | "semana" | "7dias" | "30dias" | "personalizado";

// Um <select> compacto no lugar de cinco chips: o período é sempre um filtro ativo (a
// tela nunca opera sobre "todas as datas"), então o que interessa é ler o intervalo
// vigente de relance — não manter cinco alvos de clique ocupando uma faixa inteira acima
// da lista. "Personalizado" não é escolhido aqui: ele se ativa sozinho quando o usuário
// mexe nas datas dentro de "Mais filtros".
const ATALHOS_PERIODO: Array<{ chave: AtalhoPeriodo; label: string }> = [
  { chave: "hoje", label: "Hoje" },
  { chave: "semana", label: "Esta semana" },
  { chave: "7dias", label: "Próximos 7 dias" },
  { chave: "30dias", label: "Próximos 30 dias" },
  { chave: "personalizado", label: "Período personalizado" },
];

function paraISO(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function somarDias(iso: string, dias: number): string {
  const [ano, mes, dia] = iso.split("-").map(Number);
  const data = new Date(ano, mes - 1, dia + dias);
  return paraISO(data);
}

// Segunda a domingo — semana "de trabalho" do calendário brasileiro, mesmo critério
// usado pelo Calendário (CalendarioClient) para a semana exibida.
function inicioDaSemana(data: Date): string {
  const diaSemana = data.getDay() || 7; // domingo (0) -> 7, para segunda ser sempre o piso
  const segunda = new Date(data);
  segunda.setDate(data.getDate() - (diaSemana - 1));
  return paraISO(segunda);
}

function fimDaSemana(data: Date): string {
  return somarDias(inicioDaSemana(data), 6);
}

function intervaloParaAtalho(atalho: AtalhoPeriodo, base: Date = new Date()): { inicio: string; fim: string } {
  const hoje = paraISO(base);
  switch (atalho) {
    case "hoje":
      return { inicio: hoje, fim: hoje };
    case "semana":
      return { inicio: inicioDaSemana(base), fim: fimDaSemana(base) };
    case "7dias":
      return { inicio: hoje, fim: somarDias(hoje, 6) };
    case "30dias":
      return { inicio: hoje, fim: somarDias(hoje, 29) };
    case "personalizado":
      return { inicio: hoje, fim: hoje };
  }
}

function formatarDataCurta(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

function formatarDataCompleta(data: string): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  // O ano só entra quando é diferente do atual: "31 de jul" no ano corrente, "18 de nov
  // de 2027" fora dele. Sem isso, uma reserva de 2027 e outra de 2026 apareciam com o
  // mesmo rótulo ("18 de nov") em blocos diferentes da mesma lista.
  const opcoes: Intl.DateTimeFormatOptions =
    ano === new Date().getFullYear()
      ? { day: "2-digit", month: "short" }
      : { day: "2-digit", month: "short", year: "numeric" };
  return new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR", opcoes).replace(".", "");
}

function diaRelativo(data: string): string | null {
  const hoje = new Date();
  const referencia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const [ano, mes, dia] = data.split("-").map(Number);
  const alvo = new Date(ano, mes - 1, dia);
  const diferencaEmDias = Math.round((alvo.getTime() - referencia.getTime()) / 86_400_000);
  if (diferencaEmDias === 0) return "Hoje";
  if (diferencaEmDias === 1) return "Amanhã";
  if (diferencaEmDias === -1) return "Ontem";
  return null;
}

function tituloDoDia(data: string): string {
  const relativo = diaRelativo(data);
  if (relativo) return relativo;
  const [ano, mes, dia] = data.split("-").map(Number);
  const nomeDoDia = new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR", { weekday: "long" });
  return nomeDoDia.charAt(0).toUpperCase() + nomeDoDia.slice(1);
}

// Empresa terceirizada da reserva (campo novo de ReservaDetalhe, preenchido só quando o setor é
// "Terceirizados"). Acesso tolerante: continua correto se o tipo ainda não declara o campo ou se
// a API antiga não o devolve.
function empresaDaReserva(reserva: Reserva): string | null {
  const valor = (reserva as Reserva & { empresaTerceirizada?: string | null }).empresaTerceirizada;
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function iniciais(nome: string): string {
  return nome
    .trim()
    .split(/\s+/)
    .map((parte) => parte[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Código curto e estável derivado do próprio id — dá à equipe uma referência citável
// ("a RS-2044") sem precisar de uma coluna sequencial nova no banco.
function codigoReserva(id: string): string {
  return `RS-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

export function ReservasClient({
  solicitanteNome,
  setorNome,
  perfil,
  setorId,
  usuarioId,
  telefonePerfil,
}: ReservasClientProps) {
  // Atalhos do Dashboard/Calendário chegam aqui como ?status=agendada / ?data=AAAA-MM-DD;
  // lidos só na montagem, o usuário continua livre para trocar os filtros normalmente
  // depois. `?data=` vira um período "Personalizado" de um dia só, em vez de perder o
  // deep link agora que não existe mais um campo de data única.
  const searchParams = useSearchParams();
  const dataDeepLink = searchParams.get("data");
  // "Ver reserva" (Não Conformidades e qualquer outro link externo) chega como
  // ?reserva=<id> — busca direto por id em vez de depender da reserva estar na página
  // atual da listagem (poderia estar em outro período/filtro/página).
  const reservaDeepLinkId = searchParams.get("reserva");
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState(() => searchParams.get("status") ?? "");
  // Padrão: "esta semana" — antes a tela carregava sem filtro de período nenhum, então
  // reservas de qualquer data (inclusive anos à frente) apareciam misturadas com as da
  // semana atual, ordenadas por criação. Agora sempre existe um intervalo real.
  // Link "?status=pendente" (sino/Central de Operações): solicitações quase sempre são para
  // datas futuras, então a fila abre nos próximos 30 dias em vez de só "esta semana".
  const periodoInicial: AtalhoPeriodo = searchParams.get("status") === "pendente" ? "30dias" : "semana";
  const [atalhoPeriodo, setAtalhoPeriodo] = useState<AtalhoPeriodo>(() =>
    dataDeepLink ? "personalizado" : periodoInicial
  );
  const [dataInicioFiltro, setDataInicioFiltro] = useState(
    () => dataDeepLink ?? intervaloParaAtalho(periodoInicial).inicio
  );
  const [dataFimFiltro, setDataFimFiltro] = useState(() => dataDeepLink ?? intervaloParaAtalho(periodoInicial).fim);
  // Retorno da criação que merece explicação: solicitação aguardando aprovação.
  const [avisoCriacao, setAvisoCriacao] = useState<string | null>(null);
  const [modalAberto, setModalAberto] = useState(false);
  const [reservaSelecionada, setReservaSelecionada] = useState<Reserva | null>(null);
  const [valoresIniciais, setValoresIniciais] = useState<ReservaValoresIniciais | undefined>(undefined);
  // null = preferência ainda não lida (só existe no cliente): a seção monta, mas sem consultar,
  // para quem a deixou recolhida não disparar uma consulta que seria descartada.
  const [disponibilidadeRecolhida, setDisponibilidadeRecolhida] = useState<boolean | null>(null);
  // Sobe a cada reserva criada/cancelada aqui: a timeline refaz a consulta sem esperar o SSE.
  const [revisaoDisponibilidade, setRevisaoDisponibilidade] = useState(0);
  const [erroDeepLink, setErroDeepLink] = useState<string | null>(null);

  useEffect(() => {
    if (!reservaDeepLinkId) return;
    let cancelado = false;
    apiFetch<Reserva>(`/api/v1/reservas/${reservaDeepLinkId}`)
      .then((reserva) => {
        if (!cancelado) setReservaSelecionada(reserva);
      })
      .catch((err) => {
        if (!cancelado) setErroDeepLink(mensagemDeErro(err, "Não foi possível abrir a reserva."));
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservaDeepLinkId]);

  useEffect(() => {
    let recolhida = false;
    try {
      recolhida = window.localStorage.getItem(CHAVE_DISPONIBILIDADE_RECOLHIDA) === "1";
    } catch {
      // storage indisponível: segue aberta (o padrão).
    }
    setDisponibilidadeRecolhida(recolhida);
  }, []);

  function alternarDisponibilidade() {
    const proximo = !disponibilidadeRecolhida;
    setDisponibilidadeRecolhida(proximo);
    try {
      window.localStorage.setItem(CHAVE_DISPONIBILIDADE_RECOLHIDA, proximo ? "1" : "0");
    } catch {
      // a escolha vale nesta sessão da página mesmo sem conseguir persistir.
    }
  }

  // A disponibilidade muda quando uma reserva é criada ou alterada aqui: descarta o cache
  // compartilhado (a Nova Reserva usa o mesmo) e manda a timeline reconsultar.
  function revalidarDisponibilidade() {
    invalidarDisponibilidade();
    setRevisaoDisponibilidade((v) => v + 1);
  }

  function selecionarAtalho(atalho: AtalhoPeriodo) {
    setAtalhoPeriodo(atalho);
    if (atalho !== "personalizado") {
      const { inicio, fim } = intervaloParaAtalho(atalho);
      setDataInicioFiltro(inicio);
      setDataFimFiltro(fim);
    }
  }

  // Só o texto digitado é adiado; escolher um filtro recarrega na hora.
  const buscaComAtraso = useDebounce(busca);
  const abortRef = useRef<AbortController | null>(null);

  const carregar = useCallback(async () => {
    // Cancela a requisição anterior ainda em voo: sem isso, respostas fora de ordem
    // podiam sobrescrever a lista com o resultado de um filtro já abandonado.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (buscaComAtraso) params.set("q", buscaComAtraso);
      if (statusFiltro) params.set("status", statusFiltro);
      // dateFrom/dateTo (não mais um único "data"): o backend já filtra por intervalo
      // real (WHERE r.data >= @date_from AND r.data <= @date_to), a mesma rota que o
      // Calendário já usa — não carregamos tudo para filtrar no cliente.
      if (dataInicioFiltro) params.set("dateFrom", dataInicioFiltro);
      if (dataFimFiltro) params.set("dateTo", dataFimFiltro);
      params.set("limit", String(POR_PAGINA));
      params.set("offset", String(pagina * POR_PAGINA));

      const resposta = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335"}/api/v1/reservas?${params}`,
        { credentials: "include", signal: controller.signal }
      );
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error((corpo as { erro?: string }).erro ?? "Erro ao carregar reservas.");
      }
      setReservas((await resposta.json()) as Reserva[]);
      setTotal(Number(resposta.headers.get("X-Total-Count") ?? 0));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setErro(mensagemDeErro(err, "Erro ao carregar reservas."));
    } finally {
      if (!controller.signal.aborted) setCarregando(false);
    }
  }, [buscaComAtraso, statusFiltro, dataInicioFiltro, dataFimFiltro, pagina]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Volta à primeira página sempre que o filtro muda — continuar na página 4 de um
  // resultado que agora tem 1 página só exibiria uma tabela vazia.
  useEffect(() => {
    setPagina(0);
  }, [buscaComAtraso, statusFiltro, dataInicioFiltro, dataFimFiltro]);

  // Atualização em tempo real pelo canal SSE já existente: uma reserva aprovada por outro
  // usuário aparecia aqui só depois de recarregar a página na mão.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) carregar();
    },
  });

  // Agrupamento por dia, preservando a ordem cronológica em que o backend devolveu
  // (data/hora_inicio ASC) — só dentro do período selecionado.
  const grupos = useMemo(() => {
    const porData = new Map<string, Reserva[]>();
    for (const reserva of reservas) {
      const existente = porData.get(reserva.data);
      if (existente) existente.push(reserva);
      else porData.set(reserva.data, [reserva]);
    }
    return [...porData.entries()];
  }, [reservas]);

  async function handleSalvar(valores: ReservaFormValues) {
    const criada = await apiFetch<{ status?: string; aviso?: string; reservas?: Array<{ status: string }> }>(
      "/api/v1/reservas",
      { method: "POST", body: JSON.stringify(valores) }
    );
    const statusCriada = criada?.status ?? criada?.reservas?.[0]?.status;
    setAvisoCriacao(
      criada?.aviso ??
        (statusCriada === "pendente"
          ? "Solicitação enviada. A reserva fica pendente até a aprovação de um Admin ou Gestor do setor — só então o horário fica confirmado."
          : null)
    );
    setModalAberto(false);
    setValoresIniciais(undefined);
    revalidarDisponibilidade();
    await carregar();
  }

  // Clique num trecho livre da timeline: abre a Nova Reserva já com plataforma, dia e horário
  // (fim limitado a 23:59, o máximo que um HH:mm expressa). Nada é criado até o usuário salvar.
  function handleSelecionarHorario(selecao: SelecaoHorario) {
    setValoresIniciais({
      plataformaId: selecao.plataformaId,
      motivo: "",
      prioridade: "normal",
      data: selecao.data,
      horaInicio: minutosParaHora(selecao.inicioMin),
      horaFim: minutosParaHora(Math.min(selecao.fimMin, ULTIMO_MINUTO_RESERVAVEL)),
    });
    setModalAberto(true);
  }

  // RF-RES-13: pré-preenche plataforma/motivo/prioridade (nunca data/status) de uma
  // reserva concluída/cancelada e abre o mesmo modal de criação.
  function handleReservarNovamente(reserva: Reserva) {
    setValoresIniciais({ plataformaId: reserva.plataformaId, motivo: reserva.motivo, prioridade: reserva.prioridade });
    setModalAberto(true);
  }

  async function handleCancelarSerie(recorrenciaId: string) {
    if (!confirm("Confirma o cancelamento de todas as ocorrências futuras desta série?")) return;
    await apiFetch(`/api/v1/reservas/recorrencia/${recorrenciaId}/cancelar`, { method: "POST" });
    setReservaSelecionada(null);
    revalidarDisponibilidade();
    await carregar();
  }

  // "Filtro ativo" aqui se refere só a busca/status — período é sempre um filtro ativo
  // agora (nunca "todas as datas"), então não entra nesta checagem de "algo pra limpar".
  const temFiltroSecundarioAtivo = Boolean(busca || statusFiltro);

  // Contador do botão "Mais filtros": só conta o que está escondido lá dentro e difere do
  // padrão. Sem ele, um período personalizado fechado explicaria uma lista curta sem que
  // nada na tela dissesse por quê.
  const filtrosAvancadosAtivos = atalhoPeriodo === "personalizado" ? 1 : 0;

  // Mexer nas datas do painel implica período personalizado — não faz sentido exigir que
  // o usuário troque o seletor antes de poder digitar um intervalo.
  function ajustarData(campo: "inicio" | "fim", valor: string) {
    setAtalhoPeriodo("personalizado");
    if (campo === "inicio") setDataInicioFiltro(valor);
    else setDataFimFiltro(valor);
  }

  function abrirDetalhe(reserva: Reserva) {
    setReservaSelecionada(reserva);
  }

  function abrirNovaReserva() {
    setValoresIniciais(undefined);
    setModalAberto(true);
  }

  return (
    <section>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderTexto}>
          <h1 className={styles.pageTitulo}>Reservas</h1>
          <p className={styles.pageSubtitulo}>Agende e acompanhe o uso de plataformas, salas e equipamentos.</p>
        </div>
        <button type="button" className={styles.btnNovaReserva} onClick={abrirNovaReserva}>
          <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
          Nova reserva
        </button>
      </header>

      {/* Disponibilidade das plataformas no dia, antes da listagem: quem vai reservar vê o que
          está livre e pula direto para a Nova Reserva já preenchida. */}
      <DisponibilidadeTimeline
        usuarioId={usuarioId}
        onSelecionarHorario={handleSelecionarHorario}
        recolhida={disponibilidadeRecolhida === true}
        onAlternarRecolhida={alternarDisponibilidade}
        ativo={disponibilidadeRecolhida !== null}
        revisao={revisaoDisponibilidade}
      />

      {/* Dois níveis de filtro. Nível 1 (busca + status + período) cobre praticamente
          todo o uso real e fica sempre visível; o intervalo exato de datas vive atrás de
          "Mais filtros". Antes eram duas faixas empilhadas com onze chips e dois campos
          de data — mais de 150px de altura consumidos antes da primeira reserva. */}
      <FiltrosAvancados
        ativos={filtrosAvancadosAtivos}
        contagem={
          carregando && reservas.length === 0
            ? "Carregando..."
            : `${total} ${total === 1 ? "reserva" : "reservas"}`
        }
        onLimpar={() => selecionarAtalho("semana")}
        avancados={
          <>
            <CampoFiltro label="De" htmlFor="reservas-data-inicio">
              <input
                id="reservas-data-inicio"
                type="date"
                value={dataInicioFiltro}
                max={dataFimFiltro || undefined}
                onChange={(e) => ajustarData("inicio", e.target.value)}
              />
            </CampoFiltro>
            <CampoFiltro label="Até" htmlFor="reservas-data-fim">
              <input
                id="reservas-data-fim"
                type="date"
                value={dataFimFiltro}
                min={dataInicioFiltro || undefined}
                onChange={(e) => ajustarData("fim", e.target.value)}
              />
            </CampoFiltro>
          </>
        }
      >
        <div className={styles.campoBusca}>
          <Search size={15} strokeWidth={1.75} className={styles.campoBuscaIcone} aria-hidden="true" />
          <label htmlFor="reservas-busca" className={styles.visuallyHidden}>
            Buscar reservas
          </label>
          <input
            id="reservas-busca"
            type="search"
            placeholder="Buscar reserva..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>

        <label htmlFor="reservas-periodo" className={styles.visuallyHidden}>
          Filtrar por período
        </label>
        <select
          id="reservas-periodo"
          className={styles.seletorPeriodo}
          value={atalhoPeriodo}
          onChange={(e) => selecionarAtalho(e.target.value as AtalhoPeriodo)}
        >
          {ATALHOS_PERIODO.map((atalho) => (
            <option key={atalho.chave} value={atalho.chave}>
              {atalho.label}
            </option>
          ))}
        </select>
        <span className={styles.periodoResumo}>
          {formatarDataCurta(dataInicioFiltro)} – {formatarDataCurta(dataFimFiltro)}
        </span>
      </FiltrosAvancados>

      <div className={styles.chips} role="group" aria-label="Filtrar por status">
        {FILTROS_RAPIDOS.map((filtro) => (
          <button
            key={filtro.chave || "todas"}
            type="button"
            className={`${styles.chip} ${statusFiltro === filtro.chave ? styles.chipAtivo : ""}`}
            onClick={() => setStatusFiltro(filtro.chave)}
            aria-pressed={statusFiltro === filtro.chave}
          >
            {filtro.label}
          </button>
        ))}
        {temFiltroSecundarioAtivo && (
          <button
            type="button"
            className={styles.btnLimpar}
            onClick={() => {
              setBusca("");
              setStatusFiltro("");
            }}
          >
            Limpar
          </button>
        )}
      </div>

      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}
      {avisoCriacao && (
        <div className={styles.avisoCriacao} role="status">
          <span>{avisoCriacao}</span>
          <button type="button" className={styles.btnGhost} onClick={() => setAvisoCriacao(null)}>
            Entendi
          </button>
        </div>
      )}
      {erroDeepLink && (
        <div className={styles.error} role="alert">
          {erroDeepLink}
        </div>
      )}

      {carregando && reservas.length === 0 ? (
        <div className={styles.diaGrupo}>
          <div className={styles.tabelaCartao}>
            {Array.from({ length: 4 }).map((_, indice) => (
              <div key={indice} className={styles.linhaEsqueleto}>
                <span className={styles.skeletonAvatar} />
                <span className={styles.skeletonBar} style={{ width: "22%" }} />
                <span className={styles.skeletonBar} style={{ width: "30%" }} />
                <span className={styles.skeletonBar} style={{ width: "14%" }} />
              </div>
            ))}
          </div>
        </div>
      ) : reservas.length === 0 ? (
        <div className={styles.vazio}>
          <p className={styles.vazioTitulo}>Nenhuma reserva encontrada.</p>
          <div className={styles.vazioAcoes}>
            {/* Uma ação só: limpar o que filtrou, se filtrou; senão, criar. Oferecer as
                duas ao mesmo tempo fazia dois botões disputarem o mesmo estado vazio. */}
            {temFiltroSecundarioAtivo ? (
              <button
                type="button"
                className={styles.btnLimpar}
                onClick={() => {
                  setBusca("");
                  setStatusFiltro("");
                }}
              >
                Limpar filtros
              </button>
            ) : (
              <button type="button" className={styles.btnNovaReserva} onClick={abrirNovaReserva}>
                <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
                Nova reserva
              </button>
            )}
          </div>
        </div>
      ) : (
        grupos.map(([data, itens]) => (
          <section key={data} className={styles.diaGrupo} aria-label={`${tituloDoDia(data)}, ${formatarDataCompleta(data)}`}>
            <div className={styles.diaCabecalho}>
              <h2 className={styles.diaTitulo}>{tituloDoDia(data)}</h2>
              <span className={styles.diaData}>{formatarDataCompleta(data)}</span>
              <span className={styles.diaLinha} aria-hidden="true" />
              <span className={styles.diaContagem}>{itens.length}</span>
            </div>

            <div className={styles.tabelaCartao}>
              <table className={styles.tabela}>
                <thead>
                  <tr>
                    <th scope="col">Responsável</th>
                    <th scope="col">Recurso</th>
                    <th scope="col">Horário</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((r) => {
                    // Comparação por id, nunca por nome (RN explícita desta correção —
                    // dois usuários podem ter nomes iguais/parecidos).
                    const minhaReserva = idsDeUsuarioIguais(r.solicitanteId, usuarioId);
                    return (
                    // A linha inteira abre o detalhe. Como <tr> não é focável por padrão,
                    // recebe role/tabIndex e responde a Enter/Espaço — antes, quem navega
                    // por teclado não conseguia abrir nenhuma reserva.
                    <tr
                      key={r.id}
                      className={`${styles.linha} ${minhaReserva ? styles.linhaMinha : ""}`}
                      tabIndex={0}
                      role="button"
                      aria-label={`Abrir reserva ${codigoReserva(r.id)} — ${r.plataformaNome}, ${r.horaInicio} às ${r.horaFim}${minhaReserva ? " (minha reserva)" : ""}`}
                      onClick={() => abrirDetalhe(r)}
                      onKeyDown={(evento) => {
                        if (evento.key === "Enter" || evento.key === " ") {
                          evento.preventDefault();
                          abrirDetalhe(r);
                        }
                      }}
                    >
                      <td>
                        <div className={styles.responsavel}>
                          <span className={styles.avatar} aria-hidden="true">
                            {iniciais(r.solicitanteNome)}
                          </span>
                          <span className={styles.responsavelTexto}>
                            <span className={styles.responsavelNome}>
                              <span className={styles.responsavelNomeTexto}>{r.solicitanteNome}</span>
                              {/* Só "urgente" vira selo. Prioridade normal não muda decisão
                                  nenhuma e virava ruído; "alta" desceu para a linha
                                  secundária, onde informa sem disputar com o nome. E o
                                  antigo selo "Minha reserva" saiu: o friso ember + o fundo
                                  mais quente da linha inteira (.linhaMinha) já são o
                                  indicador, sem custar uma pílula por linha. */}
                              {r.prioridade === "urgente" && (
                                <span className={styles.seloUrgente}>
                                  <TriangleAlert size={11} strokeWidth={2.25} aria-hidden="true" />
                                  Urgente
                                </span>
                              )}
                            </span>
                            <span
                              className={styles.responsavelMeta}
                              title={empresaDaReserva(r) ? `${r.setorNome} · ${empresaDaReserva(r)}` : undefined}
                            >
                              {minhaReserva && <span className={styles.marcaMinha}>Sua reserva · </span>}
                              {r.setorNome}
                              {/* Setor "Terceirizados": a empresa que de fato usa o equipamento. */}
                              {empresaDaReserva(r) && ` · ${empresaDaReserva(r)}`}
                              {r.prioridade === "alta" && " · Prioridade alta"}
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        {/* O código da reserva (RS-XXXX) migrou para o title: é uma
                            referência para citar em conversa, não algo que se lê ao varrer
                            a lista. O motivo, idem — o texto completo está no detalhe. */}
                        <span className={styles.recursoNome} title={`${r.plataformaNome} · ${codigoReserva(r.id)}`}>
                          {r.plataformaNome}
                        </span>
                        {r.plataformaLocalizacao && (
                          <span className={styles.recursoMeta} title={r.motivo}>
                            <MapPin size={12} strokeWidth={1.75} aria-hidden="true" />
                            {r.plataformaLocalizacao}
                          </span>
                        )}
                      </td>

                      <td>
                        <span className={styles.horario}>
                          {r.horaInicio} – {r.horaFim}
                        </span>
                      </td>

                      <td>
                        <ReservaStatusBadge status={r.status} />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <Paginacao
        total={total}
        pagina={pagina}
        porPagina={POR_PAGINA}
        carregando={carregando}
        onMudarPagina={setPagina}
        rotuloItens="reserva(s)"
      />

      {modalAberto && (
        <ReservaModal
          usuarioId={usuarioId}
          solicitanteNome={solicitanteNome}
          setorNome={setorNome}
          telefonePerfil={telefonePerfil}
          onClose={() => {
            setModalAberto(false);
            setValoresIniciais(undefined);
          }}
          onSalvar={handleSalvar}
          valoresIniciais={valoresIniciais}
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
            revalidarDisponibilidade();
            await carregar();
          }}
          onCancelarSerie={handleCancelarSerie}
          onReservarNovamente={handleReservarNovamente}
        />
      )}
    </section>
  );
}
