"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch } from "../lib/api";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { ReservaModal, type ReservaFormValues, type ReservaValoresIniciais } from "./ReservaModal";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

type Reserva = ReservaDetalhe;

interface ReservasClientProps {
  solicitanteNome: string;
  setorNome: string | null;
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

function formatarData(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function ReservasClient({ solicitanteNome, setorNome, perfil, setorId }: ReservasClientProps) {
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [dataFiltro, setDataFiltro] = useState("");
  const [modalAberto, setModalAberto] = useState(false);
  const [reservaSelecionada, setReservaSelecionada] = useState<Reserva | null>(null);
  const [valoresIniciais, setValoresIniciais] = useState<ReservaValoresIniciais | undefined>(undefined);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (busca) params.set("q", busca);
      if (statusFiltro) params.set("status", statusFiltro);
      if (dataFiltro) params.set("data", dataFiltro);
      const query = params.toString();
      const dados = await apiFetch<Reserva[]>(`/api/v1/reservas${query ? `?${query}` : ""}`);
      setReservas(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar reservas.");
    } finally {
      setCarregando(false);
    }
  }, [busca, statusFiltro, dataFiltro]);

  useEffect(() => {
    const timer = setTimeout(carregar, 250);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function handleSalvar(valores: ReservaFormValues) {
    await apiFetch("/api/v1/reservas", {
      method: "POST",
      body: JSON.stringify(valores),
    });
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
    await apiFetch(`/api/v1/reservas/recorrencia/${recorrenciaId}/cancelar`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setReservaSelecionada(null);
    await carregar();
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Reservas</h1>
          <p>Agende e gerencie o uso das plataformas</p>
        </div>
        <button
          className={styles.btnPrimary}
          onClick={() => {
            setValoresIniciais(undefined);
            setModalAberto(true);
          }}
        >
          Nova Reserva
        </button>
      </div>

      <div className={styles.filterBar}>
        <input
          type="text"
          placeholder="Buscar por setor, responsável, plataforma..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
        />
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="pendente">Pendente</option>
          <option value="agendada">Agendada</option>
          <option value="em_uso">Em Uso</option>
          <option value="concluida">Concluída</option>
          <option value="cancelada">Cancelada</option>
          <option value="rejeitada">Rejeitada</option>
        </select>
        <input type="date" value={dataFiltro} onChange={(e) => setDataFiltro(e.target.value)} />
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Setor</th>
              <th>Responsável</th>
              <th>Plataforma</th>
              <th>Data</th>
              <th>Horário</th>
              <th>Prioridade</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : reservas.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  Nenhuma reserva encontrada.
                </td>
              </tr>
            ) : (
              reservas.map((r) => (
                <tr key={r.id} onClick={() => setReservaSelecionada(r)} style={{ cursor: "pointer" }}>
                  <td>
                    <strong>{r.setorNome}</strong>
                  </td>
                  <td>{r.solicitanteNome}</td>
                  <td>{r.plataformaNome}</td>
                  <td>{formatarData(r.data)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.horaInicio} – {r.horaFim}
                  </td>
                  <td>
                    <PriorityBadge prioridade={r.prioridade} />
                  </td>
                  <td>
                    <ReservaStatusBadge status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
