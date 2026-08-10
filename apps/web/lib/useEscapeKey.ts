"use client";

import { useEffect } from "react";

// Fecha modais com ESC — mesmo padrão em todos os modais do app.
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onEscape();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onEscape]);
}
