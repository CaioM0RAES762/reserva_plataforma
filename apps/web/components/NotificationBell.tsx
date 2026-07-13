"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useEventosSSE } from "../lib/useEventosSSE";
import styles from "./NotificationBell.module.css";

interface Notificacao {
  id: string;
  tipo: string;
  titulo: string;
  mensagem: string;
  link: string | null;
  lida: boolean;
  criadoEm: string;
}

const POLLING_FALLBACK_MS = 30000;

export function NotificationBell() {
  const [notificacoes, setNotificacoes] = useState<Notificacao[]>([]);
  const [aberto, setAberto] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const dados = await apiFetch<Notificacao[]>("/api/v1/notificacoes");
      setNotificacoes(dados);
    } catch {
      // silencioso — falha ao carregar notificações não deve travar a navegação
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // RF-NOT-01: contador de não lidas atualizado em tempo real via SSE.
  const { conectado } = useEventosSSE({
    onEvento: (tipo, dados) => {
      if (tipo === "notificacao.nova") {
        setNotificacoes((atual) => [dados as Notificacao, ...atual].slice(0, 50));
      }
    },
  });

  // SDD §3.4/RNF-10: fallback para polling a cada 30s enquanto o canal SSE estiver
  // indisponível (proxy corporativo bloqueando, rede instável etc.).
  useEffect(() => {
    if (conectado) {
      return;
    }
    const id = setInterval(carregar, POLLING_FALLBACK_MS);
    return () => clearInterval(id);
  }, [conectado, carregar]);

  // RNF-10: ao reconectar após uma queda, sincroniza a lista imediatamente — evita perder
  // notificações que chegaram durante a janela sem conexão (ver mesmo fix no Painel TV).
  useEffect(() => {
    if (conectado) {
      carregar();
    }
  }, [conectado, carregar]);

  const naoLidas = notificacoes.filter((n) => !n.lida).length;

  async function marcarComoLida(id: string) {
    setNotificacoes((atual) => atual.map((n) => (n.id === id ? { ...n, lida: true } : n)));
    try {
      // keepalive: o clique no item navega imediatamente para o link da notificação (âncora
      // real, RF-NOT-02) — sem isso, o navegador cancela esta requisição em voo ao trocar
      // de página, e a notificação nunca é marcada como lida (bug real, achado ao testar
      // o fluxo completo no navegador).
      await apiFetch(`/api/v1/notificacoes/${id}/lida`, { method: "PATCH", body: JSON.stringify({}), keepalive: true });
    } catch {
      carregar();
    }
  }

  async function marcarTodasComoLidas() {
    setNotificacoes((atual) => atual.map((n) => ({ ...n, lida: true })));
    try {
      await apiFetch("/api/v1/notificacoes/lidas", { method: "PATCH", body: JSON.stringify({}) });
    } catch {
      carregar();
    }
  }

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={styles.bellButton}
        onClick={() => setAberto((v) => !v)}
        aria-label="Notificações"
        data-testid="notification-bell"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {naoLidas > 0 && (
          <span className={styles.badge} data-testid="notification-badge">
            {naoLidas > 9 ? "9+" : naoLidas}
          </span>
        )}
      </button>

      {aberto && (
        <>
          <div className={styles.overlay} onClick={() => setAberto(false)} />
          <div className={styles.dropdown} data-testid="notification-dropdown">
            <div className={styles.dropdownHeader}>
              <span>Notificações</span>
              {naoLidas > 0 && (
                <button type="button" className={styles.marcarTodas} onClick={marcarTodasComoLidas}>
                  Marcar todas como lidas
                </button>
              )}
            </div>
            <div className={styles.list}>
              {notificacoes.length === 0 && <div className={styles.empty}>Nenhuma notificação.</div>}
              {notificacoes.map((n) => (
                <a
                  key={n.id}
                  href={n.link ?? "#"}
                  className={`${styles.item} ${n.lida ? "" : styles.unread}`}
                  onClick={() => {
                    setAberto(false);
                    if (!n.lida) {
                      marcarComoLida(n.id);
                    }
                  }}
                >
                  <span className={styles.itemTitulo}>{n.titulo}</span>
                  <span className={styles.itemMensagem}>{n.mensagem}</span>
                  <span className={styles.itemData}>{new Date(n.criadoEm).toLocaleString("pt-BR")}</span>
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
