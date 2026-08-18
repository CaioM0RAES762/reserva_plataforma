"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, ClipboardList, SlidersHorizontal } from "lucide-react";
import styles from "../app/(app)/reservas/page.module.css";
import local from "./ChecklistsClient.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { useEventosSSE } from "../lib/useEventosSSE";
import { ChecklistFillModal } from "./ChecklistFillModal";
import { ChecklistTemplatesModal } from "./ChecklistTemplatesModal";

type SituacaoChecklist = "pendente" | "em_preenchimento" | "concluido" | "nao_conforme";

interface ChecklistItem {
  reservaId: string;
  reservaStatus: string;
  plataformaId: string;
  plataformaNome: string;
  plataformaCategoria: string;
  setorNome: string;
  responsavelNome: string;
  responsavelId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  templateNome: string | null;
  situacao: SituacaoChecklist;
  totalItens: number;
  totalRespondidos: number;
}

interface ChecklistsClientProps {
  // Comparado ao `responsavelId` de cada linha para destacar "meu checklist" — por id,
  // nunca por nome, mesmo critério da tela de Reservas.
  usuarioId: string;
  isAdmin: boolean;
}

const FILTROS_RAPIDOS: Array<{ chave: SituacaoChecklist | ""; label: string }> = [
  { chave: "", label: "Todos" },
  { chave: "pendente", label: "Pendentes" },
  { chave: "em_preenchimento", label: "Em preenchimento" },
  { chave: "concluido", label: "Concluídos" },
  { chave: "nao_conforme", label: "Com não conformidade" },
];

const SITUACAO_INFO: Record<SituacaoChecklist, { label: string; classe: string }> = {
  pendente: { label: "Pendente", classe: "situacaoPendente" },
  em_preenchimento: { label: "Em preenchimento", classe: "situacaoEmPreenchimento" },
  concluido: { label: "Concluído", classe: "situacaoConcluido" },
  nao_conforme: { label: "Não conforme", classe: "situacaoNaoConforme" },
};

const ESTADOS_FINAIS = ["concluida", "cancelada", "rejeitada"];

// Mesmo vocabulário de período da tela de Reservas, com um atalho a mais ("Histórico") —
// a área de checklists também é usada para consultar execuções passadas, que é justamente
// o que não pode mais aparecer misturado com o trabalho do dia.
type AtalhoPeriodo = "hoje" | "amanha" | "semana" | "7dias" | "historico" | "personalizado";

const ATALHOS_PERIODO: Array<{ chave: AtalhoPeriodo; label: string }> = [
  { chave: "hoje", label: "Hoje" },
  { chave: "amanha", label: "Amanhã" },
  { chave: "semana", label: "Esta semana" },
  { chave: "7dias", label: "Próximos 7 dias" },
  { chave: "historico", label: "Histórico" },
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
  return paraISO(new Date(ano, mes - 1, dia + dias));
}

// Segunda a domingo — mesmo critério de semana usado por Reservas e Calendário.
function inicioDaSemana(data: Date): string {
  const diaSemana = data.getDay() || 7;
  const segunda = new Date(data);
  segunda.setDate(data.getDate() - (diaSemana - 1));
  return paraISO(segunda);
}

function intervaloParaAtalho(atalho: AtalhoPeriodo, base: Date = new Date()): { inicio: string; fim: string } {
  const hoje = paraISO(base);
  switch (atalho) {
    case "hoje":
      return { inicio: hoje, fim: hoje };
    case "amanha":
      return { inicio: somarDias(hoje, 1), fim: somarDias(hoje, 1) };
    case "semana":
      return { inicio: inicioDaSemana(base), fim: somarDias(inicioDaSemana(base), 6) };
    case "7dias":
      return { inicio: hoje, fim: somarDias(hoje, 6) };
    case "historico":
      // Tudo até ontem: consulta de execuções passadas, sem misturar com o dia corrente.
      return { inicio: "", fim: somarDias(hoje, -1) };
    case "personalizado":
      return { inicio: hoje, fim: hoje };
  }
}

function formatarDataCurta(iso: string): string {
  if (!iso) return "";
  const [, mes, dia] = iso.split("-");
  return `${dia}/${mes}`;
}

function diaRelativo(data: string): string | null {
  const hoje = new Date();
  const referencia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const [ano, mes, dia] = data.split("-").map(Number);
  const diferenca = Math.round((new Date(ano, mes - 1, dia).getTime() - referencia.getTime()) / 86_400_000);
  if (diferenca === 0) return "Hoje";
  if (diferenca === 1) return "Amanhã";
  if (diferenca === -1) return "Ontem";
  return null;
}

function tituloDoDia(data: string): string {
  const relativo = diaRelativo(data);
  if (relativo) return relativo;
  const [ano, mes, dia] = data.split("-").map(Number);
  const nome = new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR", { weekday: "long" });
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

function formatarDataCompleta(data: string): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  const opcoes: Intl.DateTimeFormatOptions =
    ano === new Date().getFullYear()
      ? { day: "2-digit", month: "long" }
      : { day: "2-digit", month: "long", year: "numeric" };
  return new Date(ano, mes - 1, dia).toLocaleDateString("pt-BR", opcoes);
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  return partes.length === 1
    ? partes[0].slice(0, 2).toUpperCase()
    : (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

export function ChecklistsClient({ usuarioId, isAdmin }: ChecklistsClientProps) {
  const [itens, setItens] = useState<ChecklistItem[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<SituacaoChecklist | "">("");
  const [busca, setBusca] = useState("");
  const buscaDebounced = useDebounce(busca, 250);
  const [checklistAberto, setChecklistAberto] = useState<ChecklistItem | null>(null);
  const [templatesAberto, setTemplatesAberto] = useState(false);

  // Padrão "Hoje": ao abrir a página, o que precisa ser feito hoje já está na tela. Antes a
  // listagem trazia todas as datas de uma vez, agrupadas por dia, e os checklists do dia
  // ficavam perdidos no meio de meses inteiros de histórico.
  const [atalhoPeriodo, setAtalhoPeriodo] = useState<AtalhoPeriodo>("hoje");
  const [dataInicio, setDataInicio] = useState(() => intervaloParaAtalho("hoje").inicio);
  const [dataFim, setDataFim] = useState(() => intervaloParaAtalho("hoje").fim);

  function selecionarAtalho(atalho: AtalhoPeriodo) {
    setAtalhoPeriodo(atalho);
    if (atalho !== "personalizado") {
      const { inicio, fim } = intervaloParaAtalho(atalho);
      setDataInicio(inicio);
      setDataFim(fim);
    }
  }

  // O recorte de período vai para o backend (mesma abordagem de GET /reservas): não se
  // carrega o histórico inteiro para filtrar no navegador.
  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (dataInicio) params.set("de", dataInicio);
      if (dataFim) params.set("ate", dataFim);
      const query = params.toString();
      const dados = await apiFetch<ChecklistItem[]>(`/api/v1/checklists${query ? `?${query}` : ""}`);
      setItens(dados);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar os checklists."));
    } finally {
      setCarregando(false);
    }
  }, [dataInicio, dataFim]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Qualquer mudança em reserva (aprovação, criação, início automático) pode mudar quais
  // reservas exigem checklist ou o estado de um checklist em andamento — mesmo padrão de
  // atualização em tempo real já usado em Reservas/Fila de Aprovações.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) void carregar();
    },
  });

  // Situação e busca são combinadas com o período já aplicado no backend: "Hoje +
  // Pendentes" mostra só os checklists pendentes de hoje.
  const itensFiltrados = useMemo(() => {
    let resultado = itens;
    if (filtro) resultado = resultado.filter((i) => i.situacao === filtro);
    const termo = buscaDebounced.trim().toLowerCase();
    if (termo) {
      resultado = resultado.filter((i) =>
        [i.plataformaNome, i.responsavelNome, i.setorNome, i.templateNome ?? ""].some((campo) =>
          campo.toLowerCase().includes(termo)
        )
      );
    }
    return resultado;
  }, [itens, filtro, buscaDebounced]);

  const grupos = useMemo(() => {
    const mapa = new Map<string, ChecklistItem[]>();
    for (const item of itensFiltrados) {
      const lista = mapa.get(item.data) ?? [];
      lista.push(item);
      mapa.set(item.data, lista);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [itensFiltrados]);

  const meusPendentes = useMemo(
    () =>
      itensFiltrados.filter(
        (i) => i.responsavelId === usuarioId && (i.situacao === "pendente" || i.situacao === "em_preenchimento")
      ).length,
    [itensFiltrados, usuarioId]
  );

  function acaoPara(situacao: SituacaoChecklist): string {
    if (situacao === "pendente") return "Realizar checklist";
    if (situacao === "em_preenchimento") return "Continuar checklist";
    return "Ver checklist";
  }

  const temFiltroSecundarioAtivo = Boolean(busca || filtro);

  return (
    <section>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderTexto}>
          <h1 className={styles.pageTitulo}>Checklists NR-18/35</h1>
          <p className={styles.pageSubtitulo}>
            Acompanhe e realize os checklists de segurança associados às operações e reservas.
          </p>
        </div>
        {isAdmin && (
          <button type="button" className={styles.btnNovaReserva} onClick={() => setTemplatesAberto(true)}>
            <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            Gerenciar templates
          </button>
        )}
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
              <label htmlFor="chk-data-inicio">Data inicial</label>
              <input
                id="chk-data-inicio"
                type="date"
                value={dataInicio}
                max={dataFim || undefined}
                onChange={(e) => setDataInicio(e.target.value)}
              />
            </div>
            <div className={styles.campoData}>
              <label htmlFor="chk-data-fim">Data final</label>
              <input
                id="chk-data-fim"
                type="date"
                value={dataFim}
                min={dataInicio || undefined}
                onChange={(e) => setDataFim(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <span className={styles.periodoResumo}>
            {atalhoPeriodo === "historico"
              ? `até ${formatarDataCurta(dataFim)}`
              : dataInicio === dataFim
                ? formatarDataCurta(dataInicio)
                : `${formatarDataCurta(dataInicio)} – ${formatarDataCurta(dataFim)}`}
          </span>
        )}
      </div>

      <div className={styles.barraFiltros}>
        <div className={styles.campoBusca}>
          <Search size={16} strokeWidth={1.75} className={styles.campoBuscaIcone} aria-hidden="true" />
          <label htmlFor="chk-busca" className={styles.visuallyHidden}>
            Buscar checklists
          </label>
          <input
            id="chk-busca"
            type="search"
            placeholder="Buscar por plataforma, responsável ou setor..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <div className={styles.chips} role="group" aria-label="Filtrar por situação">
          {FILTROS_RAPIDOS.map((f) => (
            <button
              key={f.chave || "todos"}
              type="button"
              className={`${styles.chip} ${filtro === f.chave ? styles.chipAtivo : ""}`}
              onClick={() => setFiltro(f.chave)}
              aria-pressed={filtro === f.chave}
            >
              {f.label}
            </button>
          ))}
          {temFiltroSecundarioAtivo && (
            <button
              type="button"
              className={styles.btnLimpar}
              onClick={() => {
                setBusca("");
                setFiltro("");
              }}
            >
              Limpar filtros
            </button>
          )}
        </div>
      </div>

      <p className={styles.resultadoContagem} aria-live="polite">
        {carregando && itens.length === 0
          ? "Carregando checklists..."
          : `${itensFiltrados.length} ${itensFiltrados.length === 1 ? "checklist encontrado" : "checklists encontrados"}` +
            (meusPendentes > 0
              ? ` · ${meusPendentes} ${meusPendentes === 1 ? "aguarda" : "aguardam"} você`
              : "")}
      </p>

      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}

      {carregando && itens.length === 0 ? (
        <div className={styles.empty}>Carregando…</div>
      ) : grupos.length === 0 ? (
        <div className={styles.vazio}>
          <ClipboardList
            size={28}
            strokeWidth={1.5}
            aria-hidden="true"
            style={{ marginBottom: 8, color: "var(--ink-muted)" }}
          />
          <p className={styles.vazioTitulo}>
            {itens.length === 0
              ? "Nenhum checklist neste período."
              : "Nenhum checklist encontrado para este filtro."}
          </p>
          <p className={styles.vazioTexto}>Tente alterar o período ou os filtros.</p>
        </div>
      ) : (
        grupos.map(([data, itensDoDia]) => (
          <section
            key={data}
            className={styles.diaGrupo}
            aria-label={`${tituloDoDia(data)}, ${formatarDataCompleta(data)}`}
          >
            <div className={styles.diaCabecalho}>
              <h2 className={styles.diaTitulo}>{tituloDoDia(data)}</h2>
              <span className={styles.diaData}>{formatarDataCompleta(data)}</span>
              <span className={styles.diaLinha} aria-hidden="true" />
              <span className={styles.diaContagem}>{itensDoDia.length}</span>
            </div>

            <div className={styles.tabelaCartao}>
              <table className={styles.tabela}>
                <thead>
                  <tr>
                    <th scope="col">Responsável</th>
                    <th scope="col">Plataforma</th>
                    <th scope="col">Horário</th>
                    <th scope="col">Progresso</th>
                    <th scope="col">Situação</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {itensDoDia.map((item) => {
                    const info = SITUACAO_INFO[item.situacao];
                    // Mesmo destaque de "minha reserva" da tela de Reservas: fundo suave +
                    // faixa lateral, sem alerta exagerado.
                    const meuChecklist = item.responsavelId === usuarioId;
                    return (
                      <tr
                        key={item.reservaId}
                        className={`${styles.linha} ${meuChecklist ? styles.linhaMinha : ""}`}
                        tabIndex={0}
                        role="button"
                        aria-label={`${acaoPara(item.situacao)} — ${item.plataformaNome}, reserva de ${item.responsavelNome}${meuChecklist ? " (meu checklist)" : ""}`}
                        onClick={() => setChecklistAberto(item)}
                        onKeyDown={(evento) => {
                          if (evento.key === "Enter" || evento.key === " ") {
                            evento.preventDefault();
                            setChecklistAberto(item);
                          }
                        }}
                      >
                        <td>
                          <div className={styles.responsavel}>
                            <span className={styles.avatar} aria-hidden="true">
                              {iniciais(item.responsavelNome)}
                            </span>
                            <span className={styles.responsavelTexto}>
                              <span className={styles.responsavelNome}>
                                {item.responsavelNome}
                                {meuChecklist && <span className={styles.seloMinha}>Meu checklist</span>}
                              </span>
                              <span className={styles.responsavelMeta}>{item.setorNome}</span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <span className={styles.recursoNome}>{item.plataformaNome}</span>
                          {item.templateNome && (
                            <span className={styles.recursoMeta}>{item.templateNome}</span>
                          )}
                        </td>
                        <td>
                          <span className={styles.horario}>
                            {item.horaInicio} – {item.horaFim}
                          </span>
                        </td>
                        <td>
                          <span className={local.progressoTexto}>
                            {item.totalRespondidos} / {item.totalItens}
                          </span>
                        </td>
                        <td>
                          <span className={`${local.situacaoBadge} ${local[info.classe]}`}>{info.label}</span>
                        </td>
                        <td>
                          <span className={local.acaoLink}>{acaoPara(item.situacao)}</span>
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

      {checklistAberto && (
        <ChecklistFillModal
          reservaId={checklistAberto.reservaId}
          plataformaNome={checklistAberto.plataformaNome}
          somenteLeitura={ESTADOS_FINAIS.includes(checklistAberto.reservaStatus)}
          onClose={() => setChecklistAberto(null)}
          onAtualizado={carregar}
        />
      )}

      {templatesAberto && (
        <ChecklistTemplatesModal
          onClose={() => {
            setTemplatesAberto(false);
            void carregar();
          }}
          onAlterado={() => void carregar()}
        />
      )}
    </section>
  );
}
