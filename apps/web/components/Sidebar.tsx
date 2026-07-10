"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Sidebar.module.css";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  disponivel: boolean;
  perfis?: Array<"admin" | "gestor_setor" | "colaborador">;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    disponivel: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    href: "/plataformas",
    label: "Plataformas",
    disponivel: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M2 20h20" />
        <path d="M6 20V10l6-6 6 6v10" />
        <path d="M10 20v-5h4v5" />
      </svg>
    ),
  },
  {
    href: "/reservas",
    label: "Reservas",
    disponivel: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />
      </svg>
    ),
  },
  {
    href: "/reservas/aprovacoes",
    label: "Fila de Aprovações",
    disponivel: true,
    perfis: ["admin", "gestor_setor"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    href: "/calendario",
    label: "Calendário",
    disponivel: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    ),
  },
  {
    href: "/historico",
    label: "Histórico",
    disponivel: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
  },
];

export interface SidebarProps {
  nome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
}

const PERFIL_LABEL: Record<SidebarProps["perfil"], string> = {
  admin: "Admin",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

export function Sidebar({ nome, perfil }: SidebarProps) {
  const pathname = usePathname();
  const iniciais = nome
    .split(" ")
    .map((parte) => parte[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const itensVisiveis = NAV_ITEMS.filter((item) => !item.perfis || item.perfis.includes(perfil));

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandIcon}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <div className={styles.brandText}>
          <span className={styles.brandName}>PlataformaRes</span>
          <span className={styles.brandSub}>Gestão de Equipamentos</span>
        </div>
      </div>

      <div className={styles.profile}>
        <div className={styles.profileAvatar}>{iniciais}</div>
        <div className={styles.profileInfo}>
          <span className={styles.profileName}>{nome}</span>
          <span className={styles.profileRole}>{PERFIL_LABEL[perfil]}</span>
        </div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.navGroup}>
          <span className={styles.navLabel}>Principal</span>
          {itensVisiveis.map((item) =>
            item.disponivel ? (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem} ${pathname === item.href ? styles.active : ""}`}
              >
                {item.icon}
                {item.label}
              </Link>
            ) : (
              <div key={item.href} className={styles.navItemDisabled} title="Disponível em uma próxima sprint">
                {item.icon}
                {item.label}
                <span className={styles.navSoonTag}>em breve</span>
              </div>
            )
          )}
        </div>
      </nav>

      <div className={styles.footer}>
        <span className={styles.versionTag}>PlataformaRes — S7</span>
      </div>
    </aside>
  );
}
