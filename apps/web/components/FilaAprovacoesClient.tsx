"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import { apiFetch } from "../lib/api";
import { ReservaStatusBadge } from "./ReservaStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { ReservaDetalheModal, type ReservaDetalhe } from "./ReservaDetalheModal";

interface ReservaFila extends ReservaDetalhe {
  aguardaSegundaAprovacao: boolean;
  slaHoras: number;
  slaEstourado: boolean;
}

interface FilaAprovacoesClientProps {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

function formatarData(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function FilaAprovacoesClient({ perfil, setorId }: FilaAprovacoesClientProps) {
  const [reservas, setReservas] = useState<ReservaFila[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [semPermissao, setSemPermissao] = useState(false);
  const [reservaSelecionada, setReservaSelecionada] = useState<ReservaFila | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await apiFetch<ReservaFila[]>("/api/v1/reservas/fila-aprovacoes");
      setReservas(dados);
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("permiss")) {
        setSemPermissao(true);
      } else {
        setErro(err instanceof Error ? err.message : "Erro ao carregar a fila de aprovações.");
      }
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  if (perfil === "colaborador" || semPermissao) {
    return (
      <section>
        <div className={styles.header}>
          <div>
            <h1>Fila de Aprovações</h1>
            <p>Reservas pendentes aguardando decisão</p>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <div className={styles.empty}>
            Seu perfil (Colaborador) não aprova reservas. Fale com o Gestor do seu setor ou com o Admin.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Fila de Aprovações</h1>
          <p>
            {perfil === "admin"
              ? "Todas as reservas pendentes, incluindo as que aguardam segunda aprovação"
              : "Reservas pendentes do seu setor que ainda aguardam sua decisão"}
          </p>
        </div>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Setor</th>
              <th>Solicitante</th>
              <th>Plataforma</th>
              <th>Data</th>
              <th>Horário</th>
              <th>Prioridade</th>
              <th>Status</th>
              <th>Aprovação</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={8} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : reservas.length === 0 ? (
              <tr>
                <td colSpan={8} className={styles.empty}>
                  Nenhuma reserva pendente aguardando sua decisão.
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
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.slaEstourado && (
                      <span
                        style={{
                          display: "inline-block",
                          marginRight: 6,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "var(--red-light)",
                          color: "var(--red)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                        }}
                        title={`Prioridade urgente sem decisão há mais de ${r.slaHoras}h`}
                      >
                        SLA estourado
                      </span>
                    )}
                    {r.aguardaSegundaAprovacao && (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "#FEF3C7",
                          color: "#92400E",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                        }}
                      >
                        Aguarda 2ª aprovação
                      </span>
                    )}
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
