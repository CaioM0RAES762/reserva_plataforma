"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../app/(app)/historico/page.module.css";
import { apiFetch } from "../lib/api";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

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
  perfil: "admin" | "colaborador";
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

  useEffect(() => {
    Promise.all([apiFetch<Setor[]>("/api/v1/setores"), apiFetch<Plataforma[]>("/api/v1/plataformas")])
      .then(([dadosSetores, dadosPlataformas]) => {
        setSetores(dadosSetores);
        setPlataformas(dadosPlataformas);
      })
      .catch(() => undefined);
  }, []);

  function montarQuery(): string {
    const params = new URLSearchParams();
    if (busca) params.set("q", busca);
    if (perfil === "admin" && setorFiltro) params.set("setor", setorFiltro);
    if (plataformaFiltro) params.set("plataforma", plataformaFiltro);
    if (statusFiltro) params.set("status", statusFiltro);
    if (dataDe) params.set("dateFrom", dataDe);
    if (dataAte) params.set("dateTo", dataAte);
    return params.toString();
  }

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const query = montarQuery();
      const dados = await apiFetch<ReservaDetalhe[]>(`/api/v1/historico${query ? `?${query}` : ""}`);
      setRegistros(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar histórico.");
    } finally {
      setCarregando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca, setorFiltro, plataformaFiltro, statusFiltro, dataDe, dataAte]);

  useEffect(() => {
    const timer = setTimeout(carregar, 250);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function exportarCsv() {
    setExportando(true);
    setErro(null);
    try {
      const query = montarQuery();
      const response = await fetch(`${API_URL}/api/v1/historico/export${query ? `?${query}` : ""}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Erro ao exportar CSV.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `historico_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao exportar CSV.");
    } finally {
      setExportando(false);
    }
  }

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
          type="text"
          placeholder="Buscar..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
        />
        {perfil === "admin" && (
          <select value={setorFiltro} onChange={(e) => setSetorFiltro(e.target.value)}>
            <option value="">Todos os setores</option>
            {setores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome}
              </option>
            ))}
          </select>
        )}
        <select value={plataformaFiltro} onChange={(e) => setPlataformaFiltro(e.target.value)}>
          <option value="">Todas as plataformas</option>
          {plataformas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="pendente">Pendente</option>
          <option value="agendada">Agendada</option>
          <option value="em_uso">Em Uso</option>
          <option value="concluida">Concluída</option>
          <option value="cancelada">Cancelada</option>
          <option value="rejeitada">Rejeitada</option>
        </select>
        <input type="date" value={dataDe} onChange={(e) => setDataDe(e.target.value)} />
        <input type="date" value={dataAte} onChange={(e) => setDataAte(e.target.value)} />
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Data/Hora Reserva</th>
              <th>Setor</th>
              <th>Responsável</th>
              <th>Plataforma</th>
              <th>Período</th>
              <th>Motivo</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={9} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={9} className={styles.empty}>
                  Nenhum registro encontrado.
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
