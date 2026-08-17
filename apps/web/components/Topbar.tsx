"use client";

import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Radio } from "lucide-react";
import styles from "./Topbar.module.css";
import { NotificationBell } from "./NotificationBell";
import { useSidebarState } from "./SidebarState";

export interface TopbarProps {
  titulo: string;
}

function formatarRelogio(data: Date): string {
  const dia = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(".", "");
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${dia.toUpperCase()} · ${hora} BRT`;
}

export function Topbar({ titulo }: TopbarProps) {
  const [agora, setAgora] = useState<Date | null>(null);
  const { collapsed, toggle } = useSidebarState();

  useEffect(() => {
    // Renderizado só no cliente: o relógio do servidor difere do relógio do usuário e
    // causaria divergência de hidratação.
    setAgora(new Date());
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className={styles.topbar}>
      {/* S14 (RNF-04): abre a sidebar off-canvas abaixo de 900px — alterna o checkbox
          #sidebar-toggle (renderizado em app/(app)/layout.tsx) via label[for], sem JS. */}
      <label htmlFor="sidebar-toggle" className={styles.hamburger} aria-label="Abrir menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </label>

      {/* Recolher/expandir a sidebar no desktop — puramente visual (CSS via
          SidebarState), sem relação com o off-canvas mobile do botão ☰ acima. Fica na
          extremidade esquerda do header, antes do breadcrumb, e escondido abaixo de
          900px pela mesma media query do hamburger (Topbar.module.css). */}
      <button
        type="button"
        className={styles.collapseBtn}
        onClick={toggle}
        aria-label={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
        title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
      >
        {collapsed ? (
          <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>

      <div className={styles.left}>
        <nav className={styles.breadcrumb} aria-label="Você está em">
          <span>CENTRAL</span>
          <span className={styles.breadcrumbSep} aria-hidden="true">
            ›
          </span>
          <span className={styles.breadcrumbCurrent} aria-current="page">
            {titulo}
          </span>
        </nav>
      </div>

      <div className={styles.actions}>
        {agora && (
          <span className={styles.clock}>
            <Radio size={13} strokeWidth={1.75} className={styles.clockIcon} />
            {formatarRelogio(agora)}
          </span>
        )}
        <span className={styles.divider} aria-hidden="true" />
        <NotificationBell />
      </div>
    </header>
  );
}
