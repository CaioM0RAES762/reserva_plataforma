"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "../app/(app)/reservas/page.module.css";
import { ApiRequestError, apiFetch, mensagemDeErro } from "../lib/api";
import { useEventosSSE } from "../lib/useEventosSSE";
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
      // Antes a detecção de "sem permissão" era feita procurando a substring "permiss" na
      // mensagem de erro — qualquer ajuste de texto no backend quebraria silenciosamente
      // a tela (mostraria um erro cru no lugar da explicação de perfil). Agora usa o
      // status HTTP, que é o contrato de verdade.
      if (err instanceof ApiRequestError && err.ehSemPermissao) {
        setSemPermissao(true);
      } else {
        setErro(mensagemDeErro(err, "Erro ao carregar a fila de aprovações."));
      }
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // A fila é a tela mais sensível a tempo do sistema: uma reserva aprovada por outro
  // aprovador continuava listada aqui até o usuário recarregar a página na mão, levando a
  // um 409 ("transição inválida") ao tentar decidir sobre algo já decidido.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo.startsWith("reserva.")) carregar();
    },
  });

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

      {erro && (
              <div className={styles.error} role="alert">
                {erro}
              </div>
            )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Setor</th>
              <th scope="col">Solicitante</th>
              <th scope="col">Plataforma</th>
              <th scope="col">Data</th>
              <th scope="col">Horário</th>
              <th scope="col">Prioridade</th>
              <th scope="col">Status</th>
              <th scope="col">Aprovação</th>
            </tr>
          </thead>
          <tbody aria-busy={carregando}>
            {carregando && reservas.length === 0 ? (
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
                // Mesma correção da tela de Reservas: a linha era acionável só com mouse.
                <tr
                  key={r.id}
                  className={styles.rowClickable}
                  tabIndex={0}
                  role="button"
                  aria-label={`Decidir sobre a reserva de ${r.plataformaNome} do setor ${r.setorNome} em ${formatarData(r.data)}`}
                  onClick={() => setReservaSelecionada(r)}
                  onKeyDown={(evento) => {
                    if (evento.key === "Enter" || evento.key === " ") {
                      evento.preventDefault();
                      setReservaSelecionada(r);
                    }
                  }}
                >
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
                  {/* Selos movidos de estilo inline para classes do módulo: as cores
                      estavam em hex fixo (#FEF3C7/#92400E), fora do sistema de tokens
                      usado no resto do app — destoavam do restante e não acompanhavam
                      nenhuma mudança de tema. */}
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.slaEstourado && (
                      <span
                        className={`${styles.selo} ${styles.seloSla}`}
                        title={`Prioridade urgente sem decisão há mais de ${r.slaHoras}h`}
                      >
                        SLA estourado
                      </span>
                    )}
                    {r.aguardaSegundaAprovacao && (
                      <span
                        className={`${styles.selo} ${styles.seloSegundaAprovacao}`}
                        title="Já aprovada pelo Gestor de Setor — aguarda a decisão do Admin (RN-RES-08)"
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
