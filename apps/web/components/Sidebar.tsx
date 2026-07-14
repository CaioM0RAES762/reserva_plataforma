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
    href: "/plataformas/bloqueios",
    label: "Bloqueios de Agenda",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M4.9 4.9l14.2 14.2" />
      </svg>
    ),
  },
  {
    href: "/plataformas/painel-tv",
    label: "Painel TV",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
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
  {
    href: "/administracao/usuarios",
    label: "Usuários",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    href: "/administracao/setores",
    label: "Setores",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    href: "/administracao/configuracoes",
    label: "Configurações",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09A1.65 1.65 0 0015 4.6a1.65 1.65 0 001.82.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    href: "/administracao/auditoria",
    label: "Auditoria",
    disponivel: true,
    perfis: ["admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6M9 13h6M9 17h6" />
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
