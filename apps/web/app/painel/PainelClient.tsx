"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./painel.module.css";
import { useEventosSSE } from "../../lib/useEventosSSE";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3334";
const POLLING_FALLBACK_MS = 30000;

interface PainelReserva {
  id: string;
  plataformaNome: string;
  setorNome: string;
  horaInicio: string;
  horaFim: string;
  status: string;
}

interface PainelPlataforma {
  id: string;
  codigo: string;
  nome: string;
  status: string;
}

interface PainelDados {
  atualizadoEm: string;
  reservasHoje: PainelReserva[];
  proximasDuasHoras: PainelReserva[];
  plataformas: PainelPlataforma[];
}

const STATUS_LABEL: Record<string, string> = {
  disponivel: "Disponível",
  reservada: "Reservada",
  manutencao: "Manutenção",
  inativa: "Inativa",
  pendente: "Pendente",
  agendada: "Agendada",
  em_uso: "Em Uso",
  concluida: "Concluída",
};

// RF-TV-01/02/03: layout kiosk sem sidebar/topbar, tipografia ampliada (≥1920px),
// autorrefresh via SSE com fallback de polling — token de dispositivo lido da URL.
export function PainelClient() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [dados, setDados] = useState<PainelDados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [relogio, setRelogio] = useState(new Date());

  const carregar = useCallback(async () => {
    if (!token) {
      setErro("Token de dispositivo ausente na URL. Peça ao Admin o link completo (?token=...).");
      return;
    }
    try {
      const resposta = await fetch(`${API_URL}/api/v1/painel/dados?token=${encodeURIComponent(token)}`);
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        setErro(corpo.erro ?? "Falha ao carregar dados do painel.");
        return;
      }
      setErro(null);
      setDados(await resposta.json());
    } catch {
      setErro("Falha de conexão com o servidor.");
    }
  }, [token]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const { conectado } = useEventosSSE({
    token,
    ativo: Boolean(token),
    onEvento: (tipo) => {
      if (
        tipo === "reserva.status_alterado" ||
        tipo === "reserva.criada" ||
        tipo === "reserva.aprovada" ||
        tipo === "plataforma.status_alterado"
      ) {
        carregar();
      }
    },
  });

  // RNF-10: fallback de polling a cada 30s se o canal SSE cair (proxy bloqueando, etc.).
  useEffect(() => {
    if (conectado) {
      return;
    }
    const id = setInterval(carregar, POLLING_FALLBACK_MS);
    return () => clearInterval(id);
  }, [conectado, carregar]);

  // RNF-10: ao reconectar (queda de rede real ou simulada), busca os dados imediatamente
  // — sem isso, um erro/estado desatualizado só se recuperaria no próximo evento de
  // domínio publicado, o que pode nunca acontecer (bug real, achado testando a queda
  // deliberada da API durante esta sprint).
  useEffect(() => {
    if (conectado) {
      carregar();
    }
  }, [conectado, carregar]);

  useEffect(() => {
    const id = setInterval(() => setRelogio(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (erro) {
    return (
      <div className={styles.kiosk}>
        <div className={styles.erroBox}>{erro}</div>
      </div>
    );
  }

  if (!dados) {
    return (
      <div className={styles.kiosk}>
        <div className={styles.loading}>Carregando painel...</div>
      </div>
    );
  }

  return (
    <div className={styles.kiosk}>
      <header className={styles.header}>
        <h1>PlataformaRes</h1>
        <div className={styles.relogio}>
          {relogio.toLocaleTimeString("pt-BR")} —{" "}
          {relogio.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
        </div>
      </header>

      <div className={styles.grid}>
        <section className={styles.coluna}>
          <h2>Próximas 2 horas</h2>
          {dados.proximasDuasHoras.length === 0 ? (
            <div className={styles.vazio}>Nenhuma reserva nas próximas 2 horas.</div>
          ) : (
            dados.proximasDuasHoras.map((r) => (
              <div key={r.id} className={styles.cardReserva}>
                <span className={styles.cardHora}>
                  {r.horaInicio}–{r.horaFim}
                </span>
                <span className={styles.cardPlataforma}>{r.plataformaNome}</span>
                <span className={styles.cardSetor}>{r.setorNome}</span>
              </div>
            ))
          )}

          <h2 className={styles.subtitulo}>Reservas de hoje</h2>
          {dados.reservasHoje.length === 0 ? (
            <div className={styles.vazio}>Nenhuma reserva hoje.</div>
          ) : (
            dados.reservasHoje.map((r) => (
              <div key={r.id} className={styles.cardReservaCompacto}>
                <span className={styles.cardHora}>
                  {r.horaInicio}–{r.horaFim}
                </span>
                <span className={styles.cardPlataforma}>{r.plataformaNome}</span>
                <span className={styles.cardSetor}>{r.setorNome}</span>
                <span className={styles.statusTag}>{STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
            ))
          )}
        </section>

        <section className={styles.coluna}>
          <h2>Status das Plataformas</h2>
          <div className={styles.plataformasGrid}>
            {dados.plataformas.map((p) => (
              <div key={p.id} className={`${styles.plataformaCard} ${styles[p.status] ?? ""}`}>
                <span className={styles.plataformaCodigo}>{p.codigo}</span>
                <span className={styles.plataformaNome}>{p.nome}</span>
                <span className={styles.plataformaStatus}>{STATUS_LABEL[p.status] ?? p.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        Atualizado em {new Date(dados.atualizadoEm).toLocaleTimeString("pt-BR")} —{" "}
        {conectado ? "Ao vivo (SSE)" : "Modo polling (30s)"}
      </footer>
    </div>
  );
}
