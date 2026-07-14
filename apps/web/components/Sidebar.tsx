"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Construction,
  Ban,
  MonitorPlay,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  CalendarDays,
  History,
  BarChart3,
  Users,
  Building2,
  Settings,
  FileSearch,
} from "lucide-react";
import styles from "./Sidebar.module.css";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  grupo: "operacao" | "administracao";
  disponivel: boolean;
  perfis?: Array<"admin" | "gestor_setor" | "colaborador">;
  badgeKey?: "frota" | "aprovacoes" | "checklists";
}

const ICON_PROPS = { size: 18, strokeWidth: 1.75 };

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Central de Operações", grupo: "operacao", disponivel: true, icon: <LayoutDashboard {...ICON_PROPS} /> },
  { href: "/plataformas", label: "Frota", grupo: "operacao", disponivel: true, icon: <Construction {...ICON_PROPS} />, badgeKey: "frota" },
  { href: "/reservas", label: "Reservas", grupo: "operacao", disponivel: true, icon: <CalendarClock {...ICON_PROPS} /> },
  { href: "/calendario", label: "Calendário", grupo: "operacao", disponivel: true, icon: <CalendarDays {...ICON_PROPS} /> },
  {
    href: "/reservas/aprovacoes",
    label: "Fila de Aprovações",
    grupo: "operacao",
    disponivel: true,
    perfis: ["admin", "gestor_setor"],
    icon: <ClipboardCheck {...ICON_PROPS} />,
    badgeKey: "aprovacoes",
  },
  {
    href: "/reservas?status=agendada",
    label: "Checklists NR-18/35",
    grupo: "operacao",
    disponivel: true,
    icon: <ClipboardList {...ICON_PROPS} />,
    badgeKey: "checklists",
  },
  {
    href: "/plataformas/bloqueios",
    label: "Bloqueios de Agenda",
    grupo: "operacao",
    disponivel: true,
    perfis: ["admin"],
    icon: <Ban {...ICON_PROPS} />,
  },
  {
    href: "/plataformas/painel-tv",
    label: "Painel TV",
    grupo: "operacao",
    disponivel: true,
    perfis: ["admin"],
    icon: <MonitorPlay {...ICON_PROPS} />,
  },
  { href: "/historico", label: "Histórico", grupo: "operacao", disponivel: true, icon: <History {...ICON_PROPS} /> },
  {
    href: "/relatorios",
    label: "Relatórios",
    grupo: "operacao",
    disponivel: true,
    perfis: ["admin", "gestor_setor"],
    icon: <BarChart3 {...ICON_PROPS} />,
  },
  {
    href: "/administracao/auditoria",
    label: "Auditoria",
    grupo: "operacao",
    disponivel: true,
    perfis: ["admin"],
    icon: <FileSearch {...ICON_PROPS} />,
  },
  {
    href: "/administracao/setores",
    label: "Setores",
    grupo: "administracao",
    disponivel: true,
    perfis: ["admin"],
    icon: <Building2 {...ICON_PROPS} />,
  },
  {
    href: "/administracao/usuarios",
    label: "Usuários",
    grupo: "administracao",
    disponivel: true,
    perfis: ["admin"],
    icon: <Users {...ICON_PROPS} />,
  },
  {
    href: "/administracao/configuracoes",
    label: "Configurações",
    grupo: "administracao",
    disponivel: true,
    perfis: ["admin"],
    icon: <Settings {...ICON_PROPS} />,
  },
];

const GRUPO_LABEL: Record<NavItem["grupo"], string> = {
  operacao: "Operação",
  administracao: "Administração",
};

export interface SidebarBadges {
  frota?: number;
  aprovacoes?: number;
  checklists?: number;
}

export interface SidebarProps {
  nome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
  badges?: SidebarBadges;
}

const PERFIL_LABEL: Record<SidebarProps["perfil"], string> = {
  admin: "Admin",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

function NavLink({ item, ativo, badge }: { item: NavItem; ativo: boolean; badge?: number }) {
  if (!item.disponivel) {
    return (
      <div className={styles.navItemDisabled} title="Disponível em uma próxima sprint">
        {item.icon}
        <span>{item.label}</span>
        <span className={styles.navSoonTag}>em breve</span>
      </div>
    );
  }
  return (
    <Link href={item.href} className={`${styles.navItem} ${ativo ? styles.active : ""}`}>
      {item.icon}
      <span>{item.label}</span>
      {typeof badge === "number" && badge > 0 && <span className={styles.navBadge}>{badge}</span>}
    </Link>
  );
}

export function Sidebar({ nome, perfil, badges }: SidebarProps) {
  const pathname = usePathname();
  const iniciais = nome
    .split(" ")
    .map((parte) => parte[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const itensVisiveis = NAV_ITEMS.filter((item) => !item.perfis || item.perfis.includes(perfil));
  const grupoOperacao = itensVisiveis.filter((item) => item.grupo === "operacao");
  const grupoAdministracao = itensVisiveis.filter((item) => item.grupo === "administracao");

  const badgeFor = (item: NavItem): number | undefined => {
    if (!item.badgeKey) return undefined;
    return badges?.[item.badgeKey];
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandIcon}>PR</div>
        <div className={styles.brandText}>
          <span className={styles.brandName}>PlataformaRes</span>
          <span className={styles.brandSub}>Central de Operações</span>
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
          <span className={styles.navLabel}>{GRUPO_LABEL.operacao}</span>
          {grupoOperacao.map((item) => (
            <NavLink key={item.href} item={item} ativo={pathname === item.href.split("?")[0]} badge={badgeFor(item)} />
          ))}
        </div>

        {grupoAdministracao.length > 0 && (
          <div className={styles.navGroup}>
            <span className={styles.navLabel}>{GRUPO_LABEL.administracao}</span>
            {grupoAdministracao.map((item) => (
              <NavLink key={item.href} item={item} ativo={pathname === item.href} badge={badgeFor(item)} />
            ))}
          </div>
        )}
      </nav>

      <div className={styles.footer}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.versionTag}>PlataformaRes — S12</span>
      </div>
    </aside>
  );
}
