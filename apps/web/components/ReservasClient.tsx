"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarPlus, Clock, MapPin, Search, TriangleAlert } from "lucide-react";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { useEventosSSE } from "../lib/useEventosSSE";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
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
}

const POR_PAGINA = 50;

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

const ATALHOS_PERIODO: Array<{ chave: AtalhoPeriodo; label: string }> = [
  { chave: "hoje", label: "Hoje" },
  { chave: "semana", label: "Esta semana" },
  { chave: "7dias", label: "Próximos 7 dias" },
  { chave: "30dias", label: "Próximos 30 dias" },
  { chave: "personalizado", label: "Personalizado" },
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

export function ReservasClient({ solicitanteNome, setorNome, perfil, setorId, usuarioId }: ReservasClientProps) {
  // Atalhos do Dashboard/Calendário chegam aqui como ?status=agendada / ?data=AAAA-MM-DD;
  // lidos só na montagem, o usuário continua livre para trocar os filtros normalmente
  // depois. `?data=` vira um período "Personalizado" de um dia só, em vez de perder o
  // deep link agora que não existe mais um campo de data única.
  const searchParams = useSearchParams();
  const dataDeepLink = searchParams.get("data");
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
  const [atalhoPeriodo, setAtalhoPeriodo] = useState<AtalhoPeriodo>(() => (dataDeepLink ? "personalizado" : "semana"));
  const [dataInicioFiltro, setDataInicioFiltro] = useState(
    () => dataDeepLink ?? intervaloParaAtalho("semana").inicio
  );
  const [dataFimFiltro, setDataFimFiltro] = useState(() => dataDeepLink ?? intervaloParaAtalho("semana").fim);
  const [modalAberto, setModalAberto] = useState(false);
  const [reservaSelecionada, setReservaSelecionada] = useState<Reserva | null>(null);
  const [valoresIniciais, setValoresIniciais] = useState<ReservaValoresIniciais | undefined>(undefined);

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
    await apiFetch("/api/v1/reservas", { method: "POST", body: JSON.stringify(valores) });
    setModalAberto(false);
    setValoresIniciais(undefined);
    await carregar();
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
    await carregar();
  }

  // "Filtro ativo" aqui se refere só a busca/status — período é sempre um filtro ativo
  // agora (nunca "todas as datas"), então não entra nesta checagem de "algo pra limpar".
  const temFiltroSecundarioAtivo = Boolean(busca || statusFiltro);

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

      <div className={styles.periodoBarra} role="group" aria-label="Filtrar por período">
        <div className={styles.chips}>
          {ATALHOS_PERIODO.map((atalho) => (
            <button
              key={atalho.chave}
              type="button"
              className={`${styles.chip} ${atalhoPeriodo === atalho.chave ? styles.chipAtivo : ""}`}
              onClick={() => selecionarAtalho(atalho.chave)}
              aria-pressed={atalhoPeriodo === atalho.chave}
            >
              {atalho.label}
            </button>
          ))}
        </div>
        {atalhoPeriodo === "personalizado" ? (
          <div className={styles.periodoCustom}>
            <div className={styles.campoData}>
              <label htmlFor="reservas-data-inicio">Data inicial</label>
              <input
                id="reservas-data-inicio"
                type="date"
                value={dataInicioFiltro}
                max={dataFimFiltro || undefined}
                onChange={(e) => setDataInicioFiltro(e.target.value)}
              />
            </div>
            <div className={styles.campoData}>
              <label htmlFor="reservas-data-fim">Data final</label>
              <input
                id="reservas-data-fim"
                type="date"
                value={dataFimFiltro}
                min={dataInicioFiltro || undefined}
                onChange={(e) => setDataFimFiltro(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <span className={styles.periodoResumo}>
            {formatarDataCurta(dataInicioFiltro)} – {formatarDataCurta(dataFimFiltro)}
          </span>
        )}
      </div>

      <div className={styles.barraFiltros}>
        <div className={styles.campoBusca}>
          <Search size={15} strokeWidth={1.75} className={styles.campoBuscaIcone} aria-hidden="true" />
          <label htmlFor="reservas-busca" className={styles.visuallyHidden}>
            Buscar reservas
          </label>
          <input
            id="reservas-busca"
            type="search"
            placeholder="Buscar por setor, responsável, plataforma ou motivo..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>

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
              Limpar filtros
            </button>
          )}
        </div>
      </div>

      {/* Contagem em aria-live: o resultado muda sozinho conforme os filtros, e quem usa
          leitor de tela não tem como perceber a tabela encolhendo. */}
      <p className={styles.resultadoContagem} aria-live="polite">
        {carregando && reservas.length === 0
          ? "Carregando reservas..."
          : `${total} ${total === 1 ? "reserva encontrada" : "reservas encontradas"}`}
      </p>

      {erro && (
        <div className={styles.error} role="alert">
          {erro}
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
          <p className={styles.vazioTitulo}>Nenhuma reserva encontrada neste período.</p>
          <p className={styles.vazioTexto}>Tente alterar o período ou os filtros.</p>
          <div className={styles.vazioAcoes}>
            {temFiltroSecundarioAtivo && (
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
            )}
            <button type="button" className={styles.btnNovaReserva} onClick={abrirNovaReserva}>
              <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
              Nova reserva
            </button>
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
                    const minhaReserva = r.solicitanteId === usuarioId;
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
                              {r.solicitanteNome}
                              {minhaReserva && <span className={styles.seloMinha}>Minha reserva</span>}
                              {r.prioridade === "urgente" && (
                                <span className={styles.seloUrgente}>
                                  <TriangleAlert size={11} strokeWidth={2.25} aria-hidden="true" />
                                  Urgente
                                </span>
                              )}
                              {r.prioridade === "alta" && <span className={styles.seloAlta}>Alta</span>}
                            </span>
                            <span className={styles.responsavelMeta}>
                              {r.setorNome} · {codigoReserva(r.id)}
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        <span className={styles.recursoNome}>{r.plataformaNome}</span>
                        <span className={styles.recursoMeta}>
                          <MapPin size={12} strokeWidth={1.75} aria-hidden="true" />
                          {[r.plataformaLocalizacao, r.motivo].filter(Boolean).join(" · ")}
                        </span>
                      </td>

                      <td>
                        <span className={styles.horario}>
                          <Clock size={13} strokeWidth={1.75} aria-hidden="true" />
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
          solicitanteNome={solicitanteNome}
          setorNome={setorNome}
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
            await carregar();
          }}
          onCancelarSerie={handleCancelarSerie}
          onReservarNovamente={handleReservarNovamente}
        />
      )}
    </section>
  );
}
