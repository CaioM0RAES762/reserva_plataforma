"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../app/(app)/plataformas/page.module.css";
import { apiFetch } from "../lib/api";
import { StatusBadge } from "./StatusBadge";
import { PlataformaModal, type PlataformaEditavel, type PlataformaFormValues } from "./PlataformaModal";

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  capacidade: number | null;
  status: "disponivel" | "reservada" | "manutencao" | "inativa";
  observacoes: string | null;
}

export function PlataformasClient({ isAdmin }: { isAdmin: boolean }) {
  const [plataformas, setPlataformas] = useState<Plataforma[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<PlataformaEditavel | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (busca) params.set("q", busca);
      if (statusFiltro) params.set("status", statusFiltro);
      const query = params.toString();
      const dados = await apiFetch<Plataforma[]>(`/api/v1/plataformas${query ? `?${query}` : ""}`);
      setPlataformas(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar plataformas.");
    } finally {
      setCarregando(false);
    }
  }, [busca, statusFiltro]);

  useEffect(() => {
    const timer = setTimeout(carregar, 250);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function handleSalvar(valores: PlataformaFormValues) {
    const { status: novoStatus, ...campos } = valores;
    if (editando) {
      await apiFetch(`/api/v1/plataformas/${editando.id}`, {
        method: "PUT",
        body: JSON.stringify(campos),
      });
      if (novoStatus && novoStatus !== editando.status) {
        await apiFetch(`/api/v1/plataformas/${editando.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: novoStatus }),
        });
      }
    } else {
      await apiFetch("/api/v1/plataformas", {
        method: "POST",
        body: JSON.stringify(campos),
      });
    }
    setModalAberto(false);
    setEditando(null);
    await carregar();
  }

  async function handleToggleStatus(plataforma: Plataforma) {
    const novoStatus = plataforma.status === "inativa" ? "disponivel" : "inativa";
    setErro(null);
    try {
      await apiFetch(`/api/v1/plataformas/${plataforma.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: novoStatus }),
      });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status.");
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Plataformas</h1>
          <p>Gerencie os equipamentos e espaços compartilhados</p>
        </div>
        {isAdmin && (
          <button
            className={styles.btnPrimary}
            onClick={() => {
              setEditando(null);
              setModalAberto(true);
            }}
          >
            Nova Plataforma
          </button>
        )}
      </div>

      <div className={styles.filterBar}>
        <input
          type="text"
          placeholder="Buscar plataforma..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
        />
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="disponivel">Disponível</option>
          <option value="reservada">Reservada</option>
          <option value="manutencao">Em Manutenção</option>
          <option value="inativa">Inativa</option>
        </select>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nome</th>
              <th>Localização</th>
              <th>Capacidade</th>
              <th>Status</th>
              <th>Observações</th>
              {isAdmin && <th>Ações</th>}
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : plataformas.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  Nenhuma plataforma encontrada.
                </td>
              </tr>
            ) : (
              plataformas.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.codigo}</strong>
                  </td>
                  <td>
                    <strong>{p.nome}</strong>
                  </td>
                  <td>{p.localizacao ?? "—"}</td>
                  <td>{p.capacidade ?? "—"}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{p.observacoes ?? "—"}</td>
                  {isAdmin && (
                    <td>
                      <div className={styles.actions}>
                        <button
                          className={styles.btnIcon}
                          onClick={() => {
                            setEditando(p);
                            setModalAberto(true);
                          }}
                        >
                          Editar
                        </button>
                        <button className={styles.btnIconDanger} onClick={() => handleToggleStatus(p)}>
                          {p.status === "inativa" ? "Ativar" : "Desativar"}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalAberto && (
        <PlataformaModal
          plataforma={editando}
          onClose={() => {
            setModalAberto(false);
            setEditando(null);
          }}
          onSalvar={handleSalvar}
        />
      )}
    </section>
  );
}
