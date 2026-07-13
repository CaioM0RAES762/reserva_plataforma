"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3334";

// SDD §3.4: mesmos seis tipos de evento emitidos pelo backend em GET /api/v1/eventos.
const TIPOS_EVENTO = [
  "reserva.criada",
  "reserva.aprovada",
  "reserva.rejeitada",
  "reserva.status_alterado",
  "plataforma.status_alterado",
  "notificacao.nova",
] as const;

const BACKOFF_INICIAL_MS = 1000;
const BACKOFF_MAXIMO_MS = 30000;

export interface UseEventosSSEOptions {
  // Painel TV (dispositivo, sem sessão de usuário) — quando ausente, usa cookie JWT.
  token?: string;
  ativo?: boolean;
  onEvento: (tipo: string, dados: unknown) => void;
}

// RNF-10: reconexão automática com backoff exponencial. O consumidor decide o que fazer
// quando `conectado` fica false por tempo prolongado (ex.: cair para polling — ver
// NotificationBell.tsx e app/(painel)/painel/PainelClient.tsx).
export function useEventosSSE({ token, ativo = true, onEvento }: UseEventosSSEOptions): { conectado: boolean } {
  const [conectado, setConectado] = useState(false);
  const onEventoRef = useRef(onEvento);
  onEventoRef.current = onEvento;

  useEffect(() => {
    if (!ativo) {
      return;
    }

    let fechado = false;
    let es: EventSource | null = null;
    let tentativa = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function conectar() {
      if (fechado) {
        return;
      }
      const url = new URL(`${API_URL}/api/v1/eventos`);
      if (token) {
        url.searchParams.set("token", token);
      }
      es = new EventSource(url.toString(), { withCredentials: !token });

      es.onopen = () => {
        tentativa = 0;
        setConectado(true);
      };

      for (const tipo of TIPOS_EVENTO) {
        es.addEventListener(tipo, (evento) => {
          try {
            const dados = JSON.parse((evento as MessageEvent).data);
            onEventoRef.current(tipo, dados);
          } catch {
            // payload malformado — ignora este evento, mantém a conexão
          }
        });
      }

      es.onerror = () => {
        setConectado(false);
        es?.close();
        if (fechado) {
          return;
        }
        const atraso = Math.min(BACKOFF_INICIAL_MS * 2 ** tentativa, BACKOFF_MAXIMO_MS);
        tentativa += 1;
        timer = setTimeout(conectar, atraso);
      };
    }

    conectar();

    return () => {
      fechado = true;
      if (timer) {
        clearTimeout(timer);
      }
      es?.close();
      setConectado(false);
    };
  }, [ativo, token]);

  return { conectado };
}
