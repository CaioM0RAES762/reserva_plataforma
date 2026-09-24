"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DisponibilidadeDiaResposta } from "@plataformares/shared";
import { apiFetch, mensagemDeErro } from "./api";
import { chaveCacheDisponibilidade } from "./disponibilidadeOwnership";
import { useEventosSSE } from "./useEventosSSE";

// Fonte única de disponibilidade no frontend: Nova Reserva e a timeline "Disponibilidade"
// consomem a MESMA consulta agregada (GET /api/v1/disponibilidade?data=) em vez de cada um
// buscar reservas/bloqueios por plataforma. Duas instâncias montadas ao mesmo tempo para a
// mesma data compartilham a requisição em andamento (dedupe) e um resultado recém-obtido
// (TTL curto) — abrir o modal por cima da timeline não dispara uma segunda ida ao servidor.

const TTL_MS = 10_000;
const DEBOUNCE_SSE_MS = 400;

interface EntradaCache {
  dados: DisponibilidadeDiaResposta;
  obtidoEm: number;
}

const cache = new Map<string, EntradaCache>();
const emAndamento = new Map<string, Promise<DisponibilidadeDiaResposta>>();

function buscar(
  usuarioId: string,
  data: string,
  plataformaId: string | undefined,
  forcar: boolean
): Promise<DisponibilidadeDiaResposta> {
  const chave = chaveCacheDisponibilidade(usuarioId, data, plataformaId);
  if (!forcar) {
    const guardado = cache.get(chave);
    if (guardado && Date.now() - guardado.obtidoEm < TTL_MS) return Promise.resolve(guardado.dados);
    const pendente = emAndamento.get(chave);
    if (pendente) return pendente;
  }
  const params = new URLSearchParams({ data });
  if (plataformaId) params.set("plataformaId", plataformaId);
  const promessa = apiFetch<DisponibilidadeDiaResposta>(`/api/v1/disponibilidade?${params}`)
    .then((dados) => {
      cache.set(chave, { dados, obtidoEm: Date.now() });
      return dados;
    })
    .finally(() => {
      emAndamento.delete(chave);
    });
  emAndamento.set(chave, promessa);
  return promessa;
}

/** Descarta o cache (ex.: depois de criar/cancelar uma reserva nesta aba). */
export function invalidarDisponibilidade(): void {
  cache.clear();
}

export interface UseDisponibilidadeOptions {
  /** Segmenta cache e requisições em andamento pela identidade autenticada. */
  usuarioId: string;
  /** Restringe a resposta a uma plataforma (a consulta continua sendo UMA só). */
  plataformaId?: string;
  /** false = não busca (ex.: modal ainda sem data). */
  ativo?: boolean;
}

export interface UseDisponibilidadeResultado {
  dados: DisponibilidadeDiaResposta | null;
  carregando: boolean;
  erro: string | null;
  /** Força uma nova busca, ignorando o TTL (ex.: depois de um 409 de horário indisponível). */
  recarregar: () => Promise<void>;
}

export function useDisponibilidade(
  data: string | null | undefined,
  { usuarioId, plataformaId, ativo = true }: UseDisponibilidadeOptions
): UseDisponibilidadeResultado {
  const [resultado, setResultado] = useState<{
    chave: string;
    dados: DisponibilidadeDiaResposta;
  } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Descarta a resposta de uma consulta antiga quando data/plataforma mudam no meio do voo.
  const sequencia = useRef(0);

  const executar = useCallback(
    async (forcar: boolean) => {
      if (!ativo || !data) {
        setResultado(null);
        setCarregando(false);
        return;
      }
      const minha = ++sequencia.current;
      const chave = chaveCacheDisponibilidade(usuarioId, data, plataformaId);
      setCarregando(true);
      setErro(null);
      try {
        const resposta = await buscar(usuarioId, data, plataformaId, forcar);
        if (minha === sequencia.current) setResultado({ chave, dados: resposta });
      } catch (err) {
        if (minha === sequencia.current) {
          setResultado(null);
          setErro(mensagemDeErro(err, "Não foi possível carregar a disponibilidade."));
        }
      } finally {
        if (minha === sequencia.current) setCarregando(false);
      }
    },
    [ativo, data, plataformaId, usuarioId]
  );

  useEffect(() => {
    void executar(false);
  }, [executar]);

  // Outro usuário (ou esta própria aba) criou/cancelou/iniciou uma reserva: revalida, com
  // debounce — uma criação em série de recorrência emite vários eventos seguidos.
  const timerSse = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEventosSSE({
    ativo: ativo && !!data,
    onEvento: (tipo) => {
      if (!tipo.startsWith("reserva.") && tipo !== "plataforma.status_alterado") return;
      if (timerSse.current) clearTimeout(timerSse.current);
      timerSse.current = setTimeout(() => {
        cache.clear();
        void executar(true);
      }, DEBOUNCE_SSE_MS);
    },
  });
  useEffect(
    () => () => {
      if (timerSse.current) clearTimeout(timerSse.current);
    },
    []
  );

  const recarregar = useCallback(() => executar(true), [executar]);

  const chaveAtual = data ? chaveCacheDisponibilidade(usuarioId, data, plataformaId) : null;
  const dados = resultado?.chave === chaveAtual ? resultado.dados : null;

  return { dados, carregando, erro, recarregar };
}
