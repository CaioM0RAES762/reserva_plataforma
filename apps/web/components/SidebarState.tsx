"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { usePathname } from "next/navigation";
import { useTravarScrollDaPagina } from "../lib/useTravarScrollDaPagina";

const STORAGE_KEY = "plataformares:sidebar-collapsed";

// Mesmo corte de largura do CSS (Sidebar.module.css / Topbar.module.css): até 900px a
// sidebar vira drawer off-canvas; a partir de 901px é a coluna fixa do desktop. Se este
// valor divergir do CSS, o estado React e o layout passam a discordar sobre "estou no
// mobile?" — por isso os dois vivem lado a lado com a mesma referência.
const MQ_MOBILE = "(max-width: 900px)";

// id do <aside>: alvo do aria-controls do hambúrguer (Topbar) e âncora estável para
// inspeção. Constante exportada para os dois lados não digitarem a string duas vezes.
export const SIDEBAR_DRAWER_ID = "sidebar-drawer";

interface SidebarStateValue {
  collapsed: boolean;
  toggle: () => void;
  // Drawer mobile/tablet (<=900px). Independente de `collapsed`: recolher é uma preferência
  // de desktop; abrir/fechar o drawer é um estado transitório da sessão, nunca persistido.
  mobileAberto: boolean;
  abrirMobile: () => void;
  fecharMobile: () => void;
  alternarMobile: () => void;
  // Hambúrguer do Topbar registra-se aqui para o Sidebar devolver o foco a ele ao fechar
  // o drawer (o ref cruza dois componentes que não são pai/filho).
  gatilhoMobileRef: RefObject<HTMLButtonElement | null>;
}

const SidebarStateContext = createContext<SidebarStateValue>({
  collapsed: false,
  toggle: () => {},
  mobileAberto: false,
  abrirMobile: () => {},
  fecharMobile: () => {},
  alternarMobile: () => {},
  gatilhoMobileRef: { current: null },
});

function ehViewportMobile(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MQ_MOBILE).matches;
}

// Fonte única de verdade do estado da sidebar — Sidebar (largura/rótulos/drawer), Topbar
// (botões) e AppShell (offset do conteúdo e inert) leem o mesmo valor em vez de terem cada
// um seu próprio estado local, que dessincronizaria os três.
//
// O drawer mobile era um checkbox CSS (`#sidebar-toggle:checked ~ .sidebar`). Nunca
// funcionou: CSS Modules também localiza `#id`, então o seletor compilado virou
// `#Sidebar_sidebar-toggle__Ng7iz:checked ~ …` e jamais casava com o `id="sidebar-toggle"`
// literal do DOM. Estado React elimina essa classe de falha e ainda permite foco, ESC e
// trava de rolagem, que o checkbox não fazia.
export function SidebarStateProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileAberto, setMobileAberto] = useState(false);
  const gatilhoMobileRef = useRef<HTMLButtonElement | null>(null);
  const pathname = usePathname();

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

  // Só abre se o viewport for realmente mobile: o hambúrguer já é `display: none` no
  // desktop, mas o estado não deve depender disso — um `abrirMobile()` vindo de qualquer
  // outro lugar no desktop travaria a rolagem da página atrás de um drawer que não existe.
  const abrirMobile = useCallback(() => {
    if (ehViewportMobile()) setMobileAberto(true);
  }, []);
  const fecharMobile = useCallback(() => setMobileAberto(false), []);
  const alternarMobile = useCallback(() => {
    setMobileAberto((aberto) => (aberto ? false : ehViewportMobile()));
  }, []);

  // Qualquer troca de rota fecha o drawer — cobre o clique num item do menu, o link "Minha
  // Conta", o botão voltar do navegador e navegação vinda de fora do menu. (Clicar no item
  // da rota atual não muda o pathname; por isso o NavLink também fecha no próprio onClick.)
  useEffect(() => {
    setMobileAberto(false);
  }, [pathname]);

  // Redimensionar/girar para >900px com o drawer aberto: fecha, senão o overlay e a trava
  // de rolagem ficariam ativos sobre um layout de desktop que nem tem drawer.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MQ_MOBILE);
    function aoMudar(evento: MediaQueryListEvent) {
      if (!evento.matches) setMobileAberto(false);
    }
    mq.addEventListener("change", aoMudar);
    return () => mq.removeEventListener("change", aoMudar);
  }, []);

  // ESC: o listener só existe enquanto o drawer está aberto. useEscapeKey registraria um
  // listener global permanente em todas as telas do app só para não fazer nada com o
  // drawer fechado.
  useEffect(() => {
    if (!mobileAberto) return;
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") setMobileAberto(false);
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [mobileAberto]);

  // Rolagem do fundo travada só com o drawer aberto. `mobileAberto` nunca fica true no
  // desktop (abrirMobile filtra por viewport e o listener acima fecha ao cruzar 900px),
  // então a trava nunca chega a valer fora do mobile.
  useTravarScrollDaPagina(mobileAberto);

  const value = useMemo<SidebarStateValue>(
    () => ({ collapsed, toggle, mobileAberto, abrirMobile, fecharMobile, alternarMobile, gatilhoMobileRef }),
    [collapsed, toggle, mobileAberto, abrirMobile, fecharMobile, alternarMobile],
  );

  return <SidebarStateContext.Provider value={value}>{children}</SidebarStateContext.Provider>;
}

export function useSidebarState() {
  return useContext(SidebarStateContext);
}
