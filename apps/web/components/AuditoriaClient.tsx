"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { apiFetch } from "../lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3334";

interface Auditoria {
  id: string;
  usuarioId: string | null;
  usuarioNome: string | null;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  criadoEm: string;
}

export function AuditoriaClient() {
  const [registros, setRegistros] = useState<Auditoria[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [acao, setAcao] = useState("");
  const [entidade, setEntidade] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exportando, setExportando] = useState(false);

  const montarQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (acao) params.set("acao", acao);
    if (entidade) params.set("entidade", entidade);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    return params.toString();
  }, [acao, entidade, dateFrom, dateTo]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const query = montarQuery();
      const dados = await apiFetch<Auditoria[]>(`/api/v1/auditoria${query ? `?${query}` : ""}`);
      setRegistros(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar auditoria.");
    } finally {
      setCarregando(false);
    }
  }, [montarQuery]);

  useEffect(() => {
    const timer = setTimeout(carregar, 250);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function handleExportar() {
    setErro(null);
    setExportando(true);
    try {
      const query = montarQuery();
      const response = await fetch(`${API_URL}/api/v1/auditoria/export${query ? `?${query}` : ""}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Erro ao exportar auditoria.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `auditoria_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao exportar auditoria.");
    } finally {
      setExportando(false);
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Auditoria</h1>
          <p>Consulte e exporte o histórico de ações sensíveis do sistema (RF-AUD-01/02)</p>
        </div>
        <button className={styles.btnPrimary} onClick={handleExportar} disabled={exportando}>
          {exportando ? "Exportando..." : "Exportar CSV"}
        </button>
      </div>

      <div className={styles.filterBar}>
        <input
          type="text"
          placeholder="Filtrar por ação (ex.: criar_reserva)"
          value={acao}
          onChange={(e) => setAcao(e.target.value)}
          className={styles.search}
        />
        <select value={entidade} onChange={(e) => setEntidade(e.target.value)}>
          <option value="">Todas as entidades</option>
          <option value="Reserva">Reserva</option>
          <option value="Plataforma">Plataforma</option>
          <option value="Usuario">Usuario</option>
          <option value="Setor">Setor</option>
          <option value="ConfiguracaoSistema">ConfiguracaoSistema</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Usuário</th>
              <th>Ação</th>
              <th>Entidade</th>
              <th>ID da Entidade</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  Nenhum registro encontrado.
                </td>
              </tr>
            ) : (
              registros.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.criadoEm).toLocaleString("pt-BR")}</td>
                  <td>{r.usuarioNome ?? "Sistema"}</td>
                  <td>
                    <strong>{r.acao}</strong>
                  </td>
                  <td>{r.entidade}</td>
                  <td>{r.entidadeId ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
