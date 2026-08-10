"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarPlus, Clock, Filter, MapPin, Search, TriangleAlert } from "lucide-react";
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

export function ReservasClient({ solicitanteNome, setorNome, perfil, setorId }: ReservasClientProps) {
  // Atalhos do Dashboard chegam aqui como ?status=agendada / ?data=AAAA-MM-DD (SDD §10 —
  // "atalho para checklist pendente" etc.); lidos só na montagem, o usuário continua livre
  // para trocar os filtros normalmente depois.
  const searchParams = useSearchParams();
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState(() => searchParams.get("status") ?? "");
  const [dataFiltro, setDataFiltro] = useState(() => searchParams.get("data") ?? "");
  const [maisFiltrosAberto, setMaisFiltrosAberto] = useState(() => Boolean(searchParams.get("data")));
  const [modalAberto, setModalAberto] = useState(false);
  const [reservaSelecionada, setReservaSelecionada] = useState<Reserva | null>(null);
  const [valoresIniciais, setValoresIniciais] = useState<ReservaValoresIniciais | undefined>(undefined);

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
      if (dataFiltro) params.set("data", dataFiltro);
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
  }, [buscaComAtraso, statusFiltro, dataFiltro, pagina]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Volta à primeira página sempre que o filtro muda — continuar na página 4 de um
  // resultado que agora tem 1 página só exibiria uma tabela vazia.
  useEffect(() => {
    setPagina(0);
  }, [buscaComAtraso, statusFiltro, dataFiltro]);

  // Atualização em tempo real pelo canal SSE já existente: uma reserva aprovada por outro
  // usuário aparecia aqui só depois de recarregar a página na mão.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) carregar();
    },
  });

  // Agrupamento por dia, preservando a ordem em que o backend devolveu (data DESC).
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

  const temFiltroAtivo = Boolean(busca || statusFiltro || dataFiltro);

  function abrirDetalhe(reserva: Reserva) {
    setReservaSelecionada(reserva);
  }

  return (
    <section>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderTexto}>
          <h1 className={styles.pageTitulo}>Reservas</h1>
          <p className={styles.pageSubtitulo}>Agende e acompanhe o uso de plataformas, salas e equipamentos.</p>
        </div>
        <button
          type="button"
          className={styles.btnNovaReserva}
          onClick={() => {
            setValoresIniciais(undefined);
            setModalAberto(true);
          }}
        >
          <CalendarPlus size={16} strokeWidth={2} aria-hidden="true" />
          Nova reserva
        </button>
      </header>

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
          <button
            type="button"
            className={`${styles.chip} ${styles.chipMaisFiltros} ${dataFiltro ? styles.chipAtivo : ""}`}
            onClick={() => setMaisFiltrosAberto((aberto) => !aberto)}
            aria-expanded={maisFiltrosAberto}
            aria-controls="reservas-mais-filtros"
          >
            <Filter size={13} strokeWidth={1.75} aria-hidden="true" />
            Mais filtros
            <span className={styles.chipChevron} aria-hidden="true">
              {maisFiltrosAberto ? "▴" : "▾"}
            </span>
          </button>
        </div>
      </div>

      {maisFiltrosAberto && (
        <div className={styles.painelMaisFiltros} id="reservas-mais-filtros">
          <div className={styles.campoData}>
            <label htmlFor="reservas-data">Data específica</label>
            <input
              id="reservas-data"
              type="date"
              value={dataFiltro}
              onChange={(e) => setDataFiltro(e.target.value)}
            />
          </div>
          {temFiltroAtivo && (
            <button
              type="button"
              className={styles.btnLimpar}
              onClick={() => {
                setBusca("");
                setStatusFiltro("");
                setDataFiltro("");
              }}
            >
              Limpar filtros
            </button>
          )}
        </div>
      )}

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
          <p className={styles.vazioTitulo}>
            {temFiltroAtivo ? "Nenhuma reserva corresponde aos filtros" : "Nenhuma reserva por aqui ainda"}
          </p>
          <p className={styles.vazioTexto}>
            {temFiltroAtivo
              ? "Ajuste a busca ou volte para “Todas” para ver a agenda completa."
              : "Use “Nova reserva” para agendar o primeiro uso de uma plataforma."}
          </p>
          {temFiltroAtivo && (
            <button
              type="button"
              className={styles.btnLimpar}
              onClick={() => {
                setBusca("");
                setStatusFiltro("");
                setDataFiltro("");
              }}
            >
              Limpar filtros
            </button>
          )}
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
                  {itens.map((r) => (
                    // A linha inteira abre o detalhe. Como <tr> não é focável por padrão,
                    // recebe role/tabIndex e responde a Enter/Espaço — antes, quem navega
                    // por teclado não conseguia abrir nenhuma reserva.
                    <tr
                      key={r.id}
                      className={styles.linha}
                      tabIndex={0}
                      role="button"
                      aria-label={`Abrir reserva ${codigoReserva(r.id)} — ${r.plataformaNome}, ${r.horaInicio} às ${r.horaFim}`}
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
                  ))}
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
