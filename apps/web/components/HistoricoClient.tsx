"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../app/(app)/historico/page.module.css";
import { apiDownload, apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { Paginacao } from "./Paginacao";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";
const POR_PAGINA = 50;

interface Setor {
  id: string;
  nome: string;
  corHex: string;
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
}

interface HistoricoClientProps {
  // `gestor_setor` faltava na união: a página repassa o perfil real vindo de /conta, então
  // um Gestor chegava aqui tipado como Colaborador e era repassado assim ao modal de
  // detalhe, que decide por perfil quais ações de aprovação exibir.
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

function formatarData(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoricoClient({ perfil, setorId }: HistoricoClientProps) {
  const [registros, setRegistros] = useState<ReservaDetalhe[]>([]);
  const [setores, setSetores] = useState<Setor[]>([]);
  const [plataformas, setPlataformas] = useState<Plataforma[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [setorFiltro, setSetorFiltro] = useState("");
  const [plataformaFiltro, setPlataformaFiltro] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [dataDe, setDataDe] = useState("");
  const [dataAte, setDataAte] = useState("");
  const [reservaSelecionada, setReservaSelecionada] = useState<ReservaDetalhe | null>(null);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);

  const buscaComAtraso = useDebounce(busca);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([apiFetch<Setor[]>("/api/v1/setores"), apiFetch<Plataforma[]>("/api/v1/plataformas")])
      .then(([dadosSetores, dadosPlataformas]) => {
        setSetores(dadosSetores);
        setPlataformas(dadosPlataformas);
      })
      .catch(() => undefined);
  }, []);

  const montarQuery = useCallback(
    (comPaginacao: boolean): string => {
      const params = new URLSearchParams();
      if (buscaComAtraso) params.set("q", buscaComAtraso);
      if (perfil === "admin" && setorFiltro) params.set("setor", setorFiltro);
      if (plataformaFiltro) params.set("plataforma", plataformaFiltro);
      if (statusFiltro) params.set("status", statusFiltro);
      if (dataDe) params.set("dateFrom", dataDe);
      if (dataAte) params.set("dateTo", dataAte);
      if (comPaginacao) {
        params.set("limit", String(POR_PAGINA));
        params.set("offset", String(pagina * POR_PAGINA));
      }
      return params.toString();
    },
    [buscaComAtraso, perfil, setorFiltro, plataformaFiltro, statusFiltro, dataDe, dataAte, pagina]
  );

  const carregar = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setCarregando(true);
    setErro(null);
    try {
      const resposta = await fetch(`${API_URL}/api/v1/historico?${montarQuery(true)}`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error((corpo as { erro?: string }).erro ?? "Erro ao carregar histórico.");
      }
      setRegistros((await resposta.json()) as ReservaDetalhe[]);
      setTotal(Number(resposta.headers.get("X-Total-Count") ?? 0));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setErro(mensagemDeErro(err, "Erro ao carregar histórico."));
    } finally {
      if (!controller.signal.aborted) setCarregando(false);
    }
  }, [montarQuery]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    setPagina(0);
  }, [buscaComAtraso, setorFiltro, plataformaFiltro, statusFiltro, dataDe, dataAte]);

  async function exportarCsv() {
    setExportando(true);
    setErro(null);
    try {
      // A exportação usa os MESMOS filtros da tela, mas sem paginação — o CSV continua
      // trazendo o resultado completo, não só a página visível.
      await apiDownload(
        `/api/v1/historico/export?${montarQuery(false)}`,
        `historico_${new Date().toISOString().slice(0, 10)}.csv`
      );
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao exportar CSV."));
    } finally {
      setExportando(false);
    }
  }

  const periodoInvalido = Boolean(dataDe && dataAte && dataAte < dataDe);

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Histórico</h1>
          <p>Registro completo de todas as reservas</p>
        </div>
        <button className={styles.btnOutline} onClick={exportarCsv} disabled={exportando}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {exportando ? "Exportando..." : "Exportar CSV"}
        </button>
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          placeholder="Buscar por setor, responsável, plataforma ou motivo..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
          aria-label="Buscar no histórico"
        />
        {perfil === "admin" && (
          <select
            value={setorFiltro}
            onChange={(e) => setSetorFiltro(e.target.value)}
            aria-label="Filtrar por setor"
          >
            <option value="">Todos os setores</option>
            {setores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        )}
        <select
          value={plataformaFiltro}
          onChange={(e) => setPlataformaFiltro(e.target.value)}
          aria-label="Filtrar por plataforma"
        >
          <option value="">Todas as plataformas</option>
          {plataformas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)} aria-label="Filtrar por status">
          <option value="">Todos os status</option>
          <option value="pendente">Pendente</option>
          <option value="agendada">Agendada</option>
          <option value="em_uso">Em Uso</option>
          <option value="concluida">Concluída</option>
          <option value="cancelada">Cancelada</option>
          <option value="rejeitada">Rejeitada</option>
        </select>
        <input
          type="date"
          value={dataDe}
          onChange={(e) => setDataDe(e.target.value)}
          aria-label="Data inicial"
          max={dataAte || undefined}
        />
        <input
          type="date"
          value={dataAte}
          onChange={(e) => setDataAte(e.target.value)}
          aria-label="Data final"
          // Impede montar um período invertido no próprio seletor, em vez de deixar o
          // usuário submeter e receber uma lista vazia sem explicação.
          min={dataDe || undefined}
        />
      </div>

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
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Data/Hora Reserva</th>
              <th scope="col">Setor</th>
              <th scope="col">Responsável</th>
              <th scope="col">Plataforma</th>
              <th scope="col">Período</th>
              <th scope="col">Motivo</th>
              <th scope="col">Status</th>
              <th scope="col">Ações</th>
            </tr>
          </thead>
          <tbody aria-busy={carregando}>
            {carregando && registros.length === 0 ? (
              <tr>
                <td colSpan={9} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={9} className={styles.empty}>
                  Nenhum registro encontrado para os filtros aplicados.
                </td>
              </tr>
            ) : (
              registros.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong style={{ color: "var(--primary)", fontSize: "0.78rem" }}>{r.id.slice(0, 8)}</strong>
                  </td>
                  <td style={{ fontSize: "0.8rem" }}>{formatarDataHora(r.criadoEm)}</td>
                  <td>{r.setorNome}</td>
                  <td>{r.solicitanteNome}</td>
                  <td>{r.plataformaNome}</td>
                  <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {formatarData(r.data)}
                    <br />
                    {r.horaInicio}–{r.horaFim}
                  </td>
                  <td
                    style={{ maxWidth: 200, fontSize: "0.8rem", color: "var(--text-secondary)" }}
                    title={r.motivo}
                  >
                    {r.motivo.length > 60 ? `${r.motivo.slice(0, 60)}…` : r.motivo}
                  </td>
                  <td>
                    <ReservaStatusBadge status={r.status} />
                  </td>
                  <td>
                    <button
                      className={styles.btnIcon}
                      title="Ver detalhes"
                      aria-label={`Ver detalhes da reserva de ${r.plataformaNome} em ${formatarData(r.data)}`}
                      onClick={() => setReservaSelecionada(r)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))
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
        rotuloItens="registro(s)"
      />

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
