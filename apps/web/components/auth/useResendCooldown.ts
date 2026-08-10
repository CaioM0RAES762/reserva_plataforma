"use client";

import { useEffect, useRef, useState } from "react";

const COOLDOWN_PADRAO_SEGUNDOS = 45;

interface UseResendCooldownResult {
  segundosRestantes: number;
  emCooldown: boolean;
  iniciar: (segundos?: number) => void;
}

// Cooldown local do botão "Reenviar código". O backend já limita a 3 solicitações por
// 10 min (rate limit real, ver rateLimit.ts) — este timer só evita cliques repetidos
// enquanto o e-mail anterior está a caminho, sem substituir o limite do servidor.
export function useResendCooldown(): UseResendCooldownResult {
  const [segundosRestantes, setSegundosRestantes] = useState(0);
  const intervaloRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervaloRef.current) clearInterval(intervaloRef.current);
    };
  }, []);

  function iniciar(segundos: number = COOLDOWN_PADRAO_SEGUNDOS): void {
    if (intervaloRef.current) clearInterval(intervaloRef.current);
    setSegundosRestantes(segundos);
    intervaloRef.current = setInterval(() => {
      setSegundosRestantes((atual) => {
        if (atual <= 1) {
          if (intervaloRef.current) clearInterval(intervaloRef.current);
          return 0;
        }
        return atual - 1;
      });
    }, 1000);
  }

  return { segundosRestantes, emCooldown: segundosRestantes > 0, iniciar };
}
