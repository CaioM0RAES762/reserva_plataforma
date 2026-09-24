"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, UserCircle } from "lucide-react";
import styles from "./SidebarUserMenu.module.css";
import { apiFetch } from "../lib/api";
import { useSidebarState } from "./SidebarState";

// Mesmo corte do SidebarState: até 900px a sidebar é o drawer mobile (largura cheia).
const MQ_MOBILE = "(max-width: 900px)";
const LARGURA_MENU_RECOLHIDA = 208;
const ESPACO = 8;

export interface SidebarUserMenuProps {
  nome: string;
  perfilLabel: string;
}

// Único lugar da app que conhece o menu da conta (Minha Conta / Sair) — antes vivia no
// Topbar; migrou para o rodapé da sidebar (ver Sidebar.tsx) e continua sendo a única
// implementação, para não duplicar a lógica de abrir/fechar e de logout em dois lugares.
export function SidebarUserMenu({ nome, perfilLabel }: SidebarUserMenuProps) {
  const router = useRouter();
  const { collapsed, mobileAberto, fecharMobile } = useSidebarState();
  const [menuAberto, setMenuAberto] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const gatilhoRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Desktop: o popover vai para um portal no <body> com posição FIXA calculada a partir do
  // gatilho. Dentro do <aside> ele era cortado pelo overflow-x: hidden da sidebar (que existe
  // para a animação de largura) — com a sidebar recolhida sobrava só a metade do menu. No
  // drawer mobile a sidebar já tem largura cheia e o menu continua inline.
  const [posicao, setPosicao] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!menuAberto) {
      setPosicao(null);
      return;
    }
    if (window.matchMedia?.(MQ_MOBILE).matches) {
      setPosicao(null);
      return;
    }
    const calcular = () => {
      const rect = gatilhoRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (collapsed) {
        // Recolhida: abre à DIREITA do avatar, alinhado pela base, sem passar da viewport.
        const left = Math.min(rect.right + ESPACO, window.innerWidth - LARGURA_MENU_RECOLHIDA - ESPACO);
        setPosicao({ left, bottom: Math.max(ESPACO, window.innerHeight - rect.bottom), width: LARGURA_MENU_RECOLHIDA });
      } else {
        // Expandida: logo ACIMA da área de perfil, com a mesma largura dela.
        setPosicao({ left: rect.left, bottom: window.innerHeight - rect.top + ESPACO, width: rect.width });
      }
    };
    calcular();
    window.addEventListener("resize", calcular);
    return () => window.removeEventListener("resize", calcular);
  }, [menuAberto, collapsed]);

  useEffect(() => {
    if (!menuAberto) return;
    function aoClicarFora(evento: MouseEvent) {
      const alvo = evento.target as Node;
      // O popover em portal não é descendente do bloco do usuário: sem conferir os dois, o
      // mousedown num item fecharia o menu antes do clique (e "Minha Conta" não navegaria).
      if (menuRef.current?.contains(alvo) || popoverRef.current?.contains(alvo)) return;
      setMenuAberto(false);
    }
    // Captura + stopPropagation: com o popover aberto dentro do drawer mobile, um único ESC
    // deve fechar só o popover (camada mais interna); o listener de ESC do drawer
    // (SidebarState, fase de bolha) só recebe o ESC seguinte. O foco volta ao gatilho porque
    // o item focado dentro do popover deixa de existir ao fechar — sem isto o foco cairia no
    // <body>, fora do drawer.
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key !== "Escape") return;
      evento.stopPropagation();
      setMenuAberto(false);
      gatilhoRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("mousedown", aoClicarFora);
    document.addEventListener("keydown", aoTeclar, true);
    return () => {
      document.removeEventListener("mousedown", aoClicarFora);
      document.removeEventListener("keydown", aoTeclar, true);
    };
  }, [menuAberto]);

  // Fecha o menu quando a sidebar recolhe/expande: a âncora muda de lugar e de forma.
  useEffect(() => {
    setMenuAberto(false);
  }, [collapsed]);

  // Idem ao fechar o drawer mobile: o popover é filho do <aside>, que sai de cena — sem isto
  // ele reapareceria já aberto na próxima abertura do menu.
  useEffect(() => {
    if (!mobileAberto) setMenuAberto(false);
  }, [mobileAberto]);

  const iniciais = nome
    .split(" ")
    .map((parte) => parte[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function handleLogout() {
    setSaindo(true);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Mesmo se a chamada falhar, segue para o login: o cookie pode já ter expirado.
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className={styles.userBlock} data-collapsed={collapsed || undefined} ref={menuRef}>
      <button
        type="button"
        className={styles.userTrigger}
        ref={gatilhoRef}
        onClick={() => setMenuAberto((aberto) => !aberto)}
        aria-haspopup="menu"
        aria-expanded={menuAberto}
        aria-label={`Conta de ${nome}`}
        title={collapsed ? `${nome} · ${perfilLabel}` : undefined}
        data-testid="user-menu-trigger"
      >
        <span className={styles.userAvatar} aria-hidden="true">
          {iniciais}
        </span>
        <span className={styles.userInfo}>
          <span className={styles.userName}>{nome}</span>
          <span className={styles.userRole}>{perfilLabel}</span>
        </span>
      </button>

      {menuAberto && (posicao ? createPortal(menu(), document.body) : menu())}
    </div>
  );

  function menu() {
    return (
        <div
          ref={popoverRef}
          className={`${styles.userMenu} ${posicao ? styles.userMenuFlutuante : ""}`}
          style={posicao ?? undefined}
          role="menu"
          data-testid="user-menu"
        >
          <Link
            href="/conta"
            className={styles.userMenuItem}
            role="menuitem"
            onClick={() => {
              setMenuAberto(false);
              // Já estando em /conta o pathname não muda, então o drawer não fecharia sozinho.
              fecharMobile();
            }}
          >
            <UserCircle size={15} strokeWidth={1.75} />
            Minha Conta
          </Link>
          <button
            type="button"
            className={`${styles.userMenuItem} ${styles.userMenuItemDanger}`}
            role="menuitem"
            onClick={handleLogout}
            disabled={saindo}
            data-testid="logout-button"
          >
            <LogOut size={15} strokeWidth={1.75} />
            {saindo ? "Saindo..." : "Sair"}
          </button>
        </div>
    );
  }
}
