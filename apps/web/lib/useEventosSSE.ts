"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

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

type Ouvinte = (tipo: string, dados: unknown) => void;

// ---------------------------------------------------------------------------
// Conexão SSE compartilhada por processo, não por componente.
//
// Cada uso do hook abria seu próprio EventSource. Com o sino de notificações sempre
// montado no Topbar, mais o Dashboard, a lista de Reservas, a Fila de Aprovações e a
// Frota consumindo eventos, uma única aba manteria 2–3 conexões permanentes abertas.
// Navegadores limitam ~6 conexões simultâneas por origem em HTTP/1.1, e conexões SSE
// nunca terminam: bastariam algumas abas do sistema para consumir todo o orçamento e
// travar as requisições comuns da API. No servidor, o efeito é o mesmo multiplicado —
// cada conexão é uma entrada viva no Map de clientes e um timer de heartbeat.
//
// Agora existe UMA conexão por processo: os componentes apenas assinam e desassinam dela.
// ---------------------------------------------------------------------------
interface Canal {
  eventSource: EventSource | null;
  ouvintes: Set<Ouvinte>;
  ouvintesDeEstado: Set<(conectado: boolean) => void>;
  conectado: boolean;
  tentativa: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const canais = new Map<string, Canal>();

function obterCanal(chave: string): Canal {
  let canal = canais.get(chave);
  if (!canal) {
    canal = {
      eventSource: null,
      ouvintes: new Set(),
      ouvintesDeEstado: new Set(),
      conectado: false,
      tentativa: 0,
      timer: null,
    };
    canais.set(chave, canal);
  }
  return canal;
}

function definirEstado(canal: Canal, conectado: boolean): void {
  canal.conectado = conectado;
  for (const ouvinte of canal.ouvintesDeEstado) {
    ouvinte(conectado);
  }
}

function conectar(chave: string): void {
  const canal = obterCanal(chave);
  if (canal.eventSource || canal.ouvintes.size === 0) {
    return;
  }

  const url = new URL(`${API_URL}/api/v1/eventos`);
  const eventSource = new EventSource(url.toString(), { withCredentials: true });
  canal.eventSource = eventSource;

  eventSource.onopen = () => {
    canal.tentativa = 0;
    definirEstado(canal, true);
  };

  for (const tipo of TIPOS_EVENTO) {
    eventSource.addEventListener(tipo, (evento) => {
      let dados: unknown;
      try {
        dados = JSON.parse((evento as MessageEvent).data);
      } catch {
        // payload malformado — ignora este evento, mantém a conexão
        return;
      }
      // Cópia da lista: um ouvinte pode desassinar durante a entrega.
      for (const ouvinte of [...canal.ouvintes]) {
        try {
          ouvinte(tipo, dados);
        } catch {
          // Um consumidor que lança não pode impedir a entrega aos demais.
        }
      }
    });
  }

  eventSource.onerror = () => {
    definirEstado(canal, false);
    eventSource.close();
    canal.eventSource = null;
    if (canal.ouvintes.size === 0) {
      return;
    }
    // RNF-10: reconexão automática com backoff exponencial.
    const atraso = Math.min(BACKOFF_INICIAL_MS * 2 ** canal.tentativa, BACKOFF_MAXIMO_MS);
    canal.tentativa += 1;
    canal.timer = setTimeout(() => conectar(chave), atraso);
  };
}

function desconectarSeOcioso(chave: string): void {
  const canal = canais.get(chave);
  if (!canal || canal.ouvintes.size > 0) {
    return;
  }
  if (canal.timer) {
    clearTimeout(canal.timer);
    canal.timer = null;
  }
  canal.eventSource?.close();
  canal.eventSource = null;
  canal.conectado = false;
  canais.delete(chave);
}

export interface UseEventosSSEOptions {
  ativo?: boolean;
  onEvento: (tipo: string, dados: unknown) => void;
}

// O consumidor decide o que fazer quando `conectado` fica false por tempo prolongado
// (ex.: cair para polling — ver NotificationBell.tsx).
export function useEventosSSE({ ativo = true, onEvento }: UseEventosSSEOptions): { conectado: boolean } {
  const [conectado, setConectado] = useState(false);
  const onEventoRef = useRef(onEvento);

  // Atribuição feita num efeito, não durante a renderização: escrever numa ref no corpo
  // do componente é um efeito colateral em render, o que o React 19 em modo estrito pode
  // executar mais de uma vez.
  useEffect(() => {
    onEventoRef.current = onEvento;
  });

  useEffect(() => {
    if (!ativo) {
      setConectado(false);
      return;
    }

    const chave = "sessao";
    const canal = obterCanal(chave);

    const ouvinte: Ouvinte = (tipo, dados) => onEventoRef.current(tipo, dados);
    canal.ouvintes.add(ouvinte);
    canal.ouvintesDeEstado.add(setConectado);
    // Assinantes que chegam depois da conexão já estabelecida precisam do estado atual.
    setConectado(canal.conectado);

    conectar(chave);

    return () => {
      canal.ouvintes.delete(ouvinte);
      canal.ouvintesDeEstado.delete(setConectado);
      // A conexão só é encerrada quando o ÚLTIMO consumidor sai — navegar entre telas não
      // derruba e reabre o canal a cada troca de página.
      desconectarSeOcioso(chave);
    };
  }, [ativo]);

  return { conectado };
}
