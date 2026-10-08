"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import {
  CATEGORIAS_AUDITORIA,
  alteracaoEmTexto,
  formatarDetalhesAuditoria,
  opcoesDeEvento,
  traduzirAcao,
} from "@plataformares/shared";
import styles from "./Admin.module.css";
import local from "./AuditoriaClient.module.css";
import { CampoFiltro, FiltrosAvancados } from "./FiltrosAvancados";
import { AuditoriaDetalheDrawer } from "./AuditoriaDetalheDrawer";
import { apiDownload, apiFetch, mensagemDeErro } from "../lib/api";
import { Paginacao } from "./Paginacao";
import {
  ICONES_AUDITORIA,
  PERFIS_LEGIVEIS,
  formatarCarimbo,
  identificarRecurso,
  type RegistroAuditoria,
} from "../lib/auditoria";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";
const POR_PAGINA = 50;

interface UsuarioOpcao {
  id: string;
  nome: string;
}

/* Atalhos de período. Auditoria quase nunca começa por "escolher duas datas": começa por
   "o que aconteceu nos últimos dias". O padrão de 30 dias evita que a primeira carga
   varra a tabela inteira, e "Todo o período" mantém tudo alcançável. */
type AtalhoPeriodo = "7dias" | "30dias" | "90dias" | "tudo" | "personalizado";

const ATALHOS_PERIODO: Array<{ chave: AtalhoPeriodo; label: string }> = [
  { chave: "7dias", label: "Últimos 7 dias" },
  { chave: "30dias", label: "Últimos 30 dias" },
  { chave: "90dias", label: "Últimos 90 dias" },
  { chave: "tudo", label: "Todo o período" },
  { chave: "personalizado", label: "Período personalizado" },
];

function paraISO(data: Date): string {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
}

function intervaloDoAtalho(atalho: AtalhoPeriodo): { de: string; ate: string } {
  if (atalho === "tudo" || atalho === "personalizado") return { de: "", ate: "" };
  const dias = atalho === "7dias" ? 7 : atalho === "30dias" ? 30 : 90;
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(hoje.getDate() - (dias - 1));
  return { de: paraISO(inicio), ate: paraISO(hoje) };
}

export function AuditoriaClient({ escopoOperacional = false }: { escopoOperacional?: boolean }) {
  const [registros, setRegistros] = useState<RegistroAuditoria[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [selecionado, setSelecionado] = useState<RegistroAuditoria | null>(null);

  // Filtros de nível 1 — categoria e evento substituíram o antigo campo de texto que
  // pedia o código interno da ação ("ex.: criar_reserva").
  const [categoria, setCategoria] = useState("");
  const [acao, setAcao] = useState("");
  const [atalhoPeriodo, setAtalhoPeriodo] = useState<AtalhoPeriodo>("30dias");
  const [dateFrom, setDateFrom] = useState(() => intervaloDoAtalho("30dias").de);
  const [dateTo, setDateTo] = useState(() => intervaloDoAtalho("30dias").ate);

  // Filtros de nível 2.
  const [usuarioId, setUsuarioId] = useState("");
  const [relevancia, setRelevancia] = useState("");
  const [usuarios, setUsuarios] = useState<UsuarioOpcao[]>([]);

  const gruposDeEvento = useMemo(() => opcoesDeEvento(), []);

  function selecionarAtalho(atalho: AtalhoPeriodo) {
    setAtalhoPeriodo(atalho);
    if (atalho !== "personalizado") {
      const { de, ate } = intervaloDoAtalho(atalho);
      setDateFrom(de);
      setDateTo(ate);
    }
  }

  function ajustarData(campo: "de" | "ate", valor: string) {
    setAtalhoPeriodo("personalizado");
    if (campo === "de") setDateFrom(valor);
    else setDateTo(valor);
  }

  // Uma requisição na montagem para popular o filtro de responsável — não é N+1: a
  // listagem não consulta nada por linha, o nome do autor já vem no próprio registro.
  useEffect(() => {
    apiFetch<UsuarioOpcao[]>("/api/v1/usuarios")
      .then((lista) => setUsuarios(lista.map((u) => ({ id: u.id, nome: u.nome }))))
      .catch(() => setUsuarios([]));
  }, []);

  const montarQuery = useCallback(
    (comPaginacao: boolean) => {
      const params = new URLSearchParams();
      if (categoria) params.set("categoria", categoria);
      if (acao) params.set("acao", acao);
      if (usuarioId) params.set("usuarioId", usuarioId);
      if (relevancia) params.set("relevancia", relevancia);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (comPaginacao) {
        params.set("limit", String(POR_PAGINA));
        params.set("offset", String(pagina * POR_PAGINA));
      }
      return params.toString();
    },
    [categoria, acao, usuarioId, relevancia, dateFrom, dateTo, pagina]
  );

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await fetch(`${API_URL}/api/v1/auditoria?${montarQuery(true)}`, {
        credentials: "include",
      });
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error((corpo as { erro?: string }).erro ?? "Erro ao carregar auditoria.");
      }
      setRegistros((await resposta.json()) as RegistroAuditoria[]);
      setTotal(Number(resposta.headers.get("X-Total-Count") ?? 0));
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar auditoria."));
    } finally {
      setCarregando(false);
    }
  }, [montarQuery]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => {
    setPagina(0);
  }, [categoria, acao, usuarioId, relevancia, dateFrom, dateTo]);

  async function handleExportar() {
    setErro(null);
    setExportando(true);
    try {
      // Exportação sempre com o resultado completo do filtro, sem a janela de paginação.
      await apiDownload(
        `/api/v1/auditoria/export?${montarQuery(false)}`,
        `auditoria_${new Date().toISOString().slice(0, 10)}.csv`
      );
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao exportar auditoria."));
    } finally {
      setExportando(false);
    }
  }

  const periodoInvalido = Boolean(dateFrom && dateTo && dateTo < dateFrom);
  const filtrosAvancadosAtivos = [usuarioId, relevancia].filter(Boolean).length +
    (atalhoPeriodo === "personalizado" ? 1 : 0);
  const temQualquerFiltro = Boolean(categoria || acao || usuarioId || relevancia) || atalhoPeriodo !== "30dias";

  function limparTudo() {
    setCategoria("");
    setAcao("");
    setUsuarioId("");
    setRelevancia("");
    selecionarAtalho("30dias");
  }

  const rotuloPeriodo = ATALHOS_PERIODO.find((a) => a.chave === atalhoPeriodo)?.label.toLowerCase() ?? "";

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>{escopoOperacional ? "Auditoria operacional" : "Auditoria"}</h1>
          <p>Veja quem fez cada alteração e o que foi modificado.</p>
        </div>
        {/* Exportação completa é exclusiva do Admin (a API também recusa). */}
        {!escopoOperacional && (
          <button type="button" className={styles.btnPrimary} onClick={handleExportar} disabled={exportando}>
            <Download size={15} strokeWidth={1.75} aria-hidden="true" />
            {exportando ? "Exportando..." : "Exportar CSV"}
          </button>
        )}
      </div>

      {escopoOperacional && (
        <p className={local.avisoEscopo} role="note" data-testid="auditoria-aviso-escopo">
          Resultados limitados ao seu escopo: reservas do seu setor, plataformas do seu setor, que você cadastrou ou
          pelas quais é responsável, e as suas próprias ações operacionais.
        </p>
      )}

      {/* Nível 1: categoria e evento — os dois recortes com que uma investigação começa
          ("mexeram na frota?", "quem aprovou?"). O antigo campo de texto pedia o código
          interno da ação, o que só funcionava para quem conhecia o backend. */}
      <FiltrosAvancados
        ativos={filtrosAvancadosAtivos}
        contagem={
          carregando && registros.length === 0
            ? "Carregando..."
            : `${total} ${total === 1 ? "evento" : "eventos"}${rotuloPeriodo ? ` · ${rotuloPeriodo}` : ""}`
        }
        onLimpar={limparTudo}
        avancados={
          <>
            <CampoFiltro label="Responsável" htmlFor="aud-usuario">
              <select id="aud-usuario" value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)}>
                <option value="">Todos</option>
                {usuarios.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nome}
                  </option>
                ))}
              </select>
            </CampoFiltro>
            <CampoFiltro label="Importância" htmlFor="aud-relevancia">
              <select id="aud-relevancia" value={relevancia} onChange={(e) => setRelevancia(e.target.value)}>
                <option value="">Todas</option>
                <option value="importante">Somente importantes</option>
                <option value="normal">Rotina</option>
                <option value="informativa">Atividade informativa</option>
              </select>
            </CampoFiltro>
            <CampoFiltro label="De" htmlFor="aud-de">
              <input
                id="aud-de"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => ajustarData("de", e.target.value)}
              />
            </CampoFiltro>
            <CampoFiltro label="Até" htmlFor="aud-ate">
              <input
                id="aud-ate"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => ajustarData("ate", e.target.value)}
              />
            </CampoFiltro>
          </>
        }
      >
        <label htmlFor="aud-categoria" className={styles.visuallyHidden}>
          Filtrar por categoria
        </label>
        <select
          id="aud-categoria"
          className={local.seletor}
          value={categoria}
          onChange={(e) => {
            setCategoria(e.target.value);
            // Trocar de categoria invalida um evento escolhido em outra categoria.
            setAcao("");
          }}
        >
          <option value="">Todas as categorias</option>
          {CATEGORIAS_AUDITORIA.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label htmlFor="aud-evento" className={styles.visuallyHidden}>
          Filtrar por evento
        </label>
        {/* Os rótulos são os do catálogo; o valor enviado à API continua sendo o código
            interno (`criar_reserva`) — a tradução é de apresentação, não de dado. */}
        <select id="aud-evento" className={local.seletor} value={acao} onChange={(e) => setAcao(e.target.value)}>
          <option value="">Todos os eventos</option>
          {gruposDeEvento
            .filter((grupo) => !categoria || grupo.categoria === categoria)
            .map((grupo) => (
              <optgroup key={grupo.categoria} label={grupo.categoria}>
                {grupo.eventos.map((evento) => (
                  <option key={evento.valor} value={evento.valor}>
                    {evento.rotulo}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>

        <label htmlFor="aud-periodo" className={styles.visuallyHidden}>
          Filtrar por período
        </label>
        <select
          id="aud-periodo"
          className={local.seletor}
          value={atalhoPeriodo}
          onChange={(e) => selecionarAtalho(e.target.value as AtalhoPeriodo)}
        >
          {ATALHOS_PERIODO.map((a) => (
            <option key={a.chave} value={a.chave}>
              {a.label}
            </option>
          ))}
        </select>
      </FiltrosAvancados>

      {periodoInvalido && (
        <div className={styles.error} role="alert">
          A data final é anterior à data inicial — ajuste o período para ver resultados.
        </div>
      )}
      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={`${styles.table} ${local.tabela}`}>
          <thead>
            <tr>
              <th scope="col">Data/hora</th>
              <th scope="col">Responsável</th>
              <th scope="col">Evento</th>
              <th scope="col">Recurso</th>
              <th scope="col">Alteração</th>
            </tr>
          </thead>
          <tbody aria-busy={carregando}>
            {carregando && registros.length === 0 ? (
              // Esqueleto no formato das linhas reais: a altura da tabela não colapsa
              // entre um filtro e outro, então não há salto de layout.
              Array.from({ length: 8 }).map((_, indice) => (
                <tr key={indice} className={local.linhaEsqueleto}>
                  {Array.from({ length: 5 }).map((__, coluna) => (
                    <td key={coluna}>
                      <span className={local.esqueletoBarra} />
                    </td>
                  ))}
                </tr>
              ))
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className={local.vazio}>
                    <p className={local.vazioTitulo}>Nenhum evento encontrado.</p>
                    {temQualquerFiltro ? (
                      <button type="button" className={local.vazioAcao} onClick={limparTudo}>
                        Limpar filtros
                      </button>
                    ) : (
                      <p className={local.vazioTexto}>Ajuste os filtros para ampliar a busca.</p>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              registros.map((registro) => {
                const meta = traduzirAcao(registro.acao);
                const recurso = identificarRecurso(registro);
                const alteracao = formatarDetalhesAuditoria(registro.acao, registro.detalhes as never, {
                  entidade: registro.entidade,
                });
                const alteracaoTexto = alteracaoEmTexto(alteracao);
                const carimbo = formatarCarimbo(registro.criadoEm);
                const Icone = ICONES_AUDITORIA[meta.icone];
                const automatico = !registro.usuarioNome;

                return (
                  <tr
                    key={registro.id}
                    className={`${local.linha} ${meta.relevancia === "informativa" ? local.linhaInformativa : ""}`}
                    tabIndex={0}
                    role="button"
                    aria-label={`Detalhes do evento: ${meta.titulo}, ${carimbo.data} às ${carimbo.hora}`}
                    onClick={() => setSelecionado(registro)}
                    onKeyDown={(evento) => {
                      if (evento.key === "Enter" || evento.key === " ") {
                        evento.preventDefault();
                        setSelecionado(registro);
                      }
                    }}
                  >
                    <td className={local.celulaData}>
                      <span className={local.dataDia}>{carimbo.data}</span>
                      <span className={local.dataHora}>{carimbo.hora}</span>
                    </td>

                    <td className={local.celulaResponsavel}>
                      <span className={local.responsavelNome}>{registro.usuarioNome ?? "Sistema"}</span>
                      <span className={local.responsavelPerfil}>
                        {automatico
                          ? "Ação automática"
                          : PERFIS_LEGIVEIS[registro.usuarioPerfil ?? ""] ?? ""}
                      </span>
                    </td>

                    <td className={local.celulaEvento}>
                      <span className={local.eventoTitulo}>
                        {/* Cor só no indicador, nunca na linha inteira: o que muda de
                            evento para evento é o ponto, não o fundo da tabela. */}
                        <span
                          className={`${local.tom} ${local[`tom_${meta.tom}`]}`}
                          aria-hidden="true"
                        />
                        <Icone size={14} strokeWidth={1.75} className={local.eventoIcone} aria-hidden="true" />
                        {meta.titulo}
                      </span>
                      <span className={local.eventoCategoria}>{meta.categoria}</span>
                    </td>

                    <td className={local.celulaRecurso}>
                      <span className={local.recursoNome} title={recurso.nome ?? undefined}>
                        {recurso.nome ?? recurso.tipo}
                      </span>
                      <span className={local.recursoDetalhe} title={recurso.detalhe ?? undefined}>
                        {recurso.nome ? recurso.detalhe ?? recurso.tipo : ""}
                      </span>
                    </td>

                    <td className={local.celulaAlteracao}>
                      {alteracao.de || alteracao.para ? (
                        <span className={local.transicao} title={alteracaoTexto}>
                          <span className={local.transicaoDe}>{alteracao.de || "—"}</span>
                          <span className={local.transicaoSeta} aria-hidden="true">
                            →
                          </span>
                          <span className={local.transicaoPara}>{alteracao.para || "—"}</span>
                        </span>
                      ) : alteracaoTexto ? (
                        <span className={local.alteracaoResumo} title={alteracaoTexto}>
                          {alteracaoTexto}
                        </span>
                      ) : (
                        <span className={local.semAlteracao}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Paginacao
        total={total}
        pagina={pagina}
        porPagina={POR_PAGINA}
        carregando={carregando}
        onMudarPagina={setPagina}
        rotuloItens="eventos"
      />

      {selecionado && (
        <AuditoriaDetalheDrawer registro={selecionado} onClose={() => setSelecionado(null)} />
      )}
    </section>
  );
}
