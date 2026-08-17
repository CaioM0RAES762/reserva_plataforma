"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "plataformares:sidebar-collapsed";

interface SidebarStateValue {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarStateContext = createContext<SidebarStateValue>({ collapsed: false, toggle: () => {} });

// Fonte única de verdade do estado de colapso da sidebar — Sidebar (largura/rótulos),
// Topbar (botão) e AppShell (offset do conteúdo) leem o mesmo valor em vez de terem cada
// um seu próprio estado local, que dessincronizaria os três.
export function SidebarStateProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  // A leitura do localStorage só acontece depois de montar: no servidor não existe
  // localStorage, então usar o valor salvo já na primeira renderização do cliente
  // produziria HTML diferente do que o servidor mandou (hydration mismatch). O preço é
  // a sidebar sempre nascer expandida por um instante antes de aplicar a preferência.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Storage indisponível (modo privado, política do navegador etc.) — segue expandida.
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((atual) => {
      const proximo = !atual;
      try {
        window.localStorage.setItem(STORAGE_KEY, proximo ? "1" : "0");
      } catch {
        // Ignora falha de escrita — a preferência só não persiste entre sessões.
      }
      return proximo;
    });
  }, []);

  return <SidebarStateContext.Provider value={{ collapsed, toggle }}>{children}</SidebarStateContext.Provider>;
}

export function useSidebarState() {
  return useContext(SidebarStateContext);
}
