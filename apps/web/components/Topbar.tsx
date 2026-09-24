"use client";

import { useEffect, useState } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, Radio } from "lucide-react";
import styles from "./Topbar.module.css";
import { NotificationBell } from "./NotificationBell";
import { SIDEBAR_DRAWER_ID, useSidebarState } from "./SidebarState";

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
  const { collapsed, toggle, mobileAberto, alternarMobile, gatilhoMobileRef } = useSidebarState();

  useEffect(() => {
    // Renderizado só no cliente: o relógio do servidor difere do relógio do usuário e
    // causaria divergência de hidratação.
    setAgora(new Date());
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className={styles.topbar}>
      {/* S14 (RNF-04): abre o drawer da sidebar (<=900px; escondido acima disso via CSS).
          O ref permite ao Sidebar devolver o foco a este botão quando o drawer fecha. Com o
          drawer aberto o Topbar fica inerte (AppShell), então o rótulo "Abrir menu" nunca
          precisa virar "Fechar" — o botão de fechar vive dentro do próprio drawer. */}
      <button
        type="button"
        ref={gatilhoMobileRef}
        className={styles.hamburger}
        onClick={alternarMobile}
        aria-label="Abrir menu"
        aria-expanded={mobileAberto}
        aria-controls={SIDEBAR_DRAWER_ID}
        data-testid="sidebar-hamburger"
      >
        <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>

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
          <span className={styles.breadcrumbCurrent} aria-current="page" title={titulo}>
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
