"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, UserCircle } from "lucide-react";
import styles from "./SidebarUserMenu.module.css";
import { apiFetch } from "../lib/api";
import { useSidebarState } from "./SidebarState";

export interface SidebarUserMenuProps {
  nome: string;
  perfilLabel: string;
}

// Único lugar da app que conhece o menu da conta (Minha Conta / Sair) — antes vivia no
// Topbar; migrou para o rodapé da sidebar (ver Sidebar.tsx) e continua sendo a única
// implementação, para não duplicar a lógica de abrir/fechar e de logout em dois lugares.
export function SidebarUserMenu({ nome, perfilLabel }: SidebarUserMenuProps) {
  const router = useRouter();
  const { collapsed } = useSidebarState();
  const [menuAberto, setMenuAberto] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuAberto) return;
    function aoClicarFora(evento: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(evento.target as Node)) {
        setMenuAberto(false);
      }
    }
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") setMenuAberto(false);
    }
    document.addEventListener("mousedown", aoClicarFora);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("mousedown", aoClicarFora);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [menuAberto]);

  // Fecha o menu ao recolher a sidebar — evita um popover órfão ancorado numa coluna
  // de 72px de largura.
  useEffect(() => {
    if (collapsed) setMenuAberto(false);
  }, [collapsed]);

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

      {menuAberto && (
        <div className={styles.userMenu} role="menu" data-testid="user-menu">
          <Link href="/conta" className={styles.userMenuItem} role="menuitem" onClick={() => setMenuAberto(false)}>
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
      )}
    </div>
  );
}
