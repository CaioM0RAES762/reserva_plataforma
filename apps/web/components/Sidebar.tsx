"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Construction,
  Ban,
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
import { useSidebarState } from "./SidebarState";
import { SidebarUserMenu } from "./SidebarUserMenu";

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
    href: "/checklists",
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
    <Link
      href={item.href}
      className={`${styles.navItem} ${ativo ? styles.active : ""}`}
      // Leitores de tela anunciam qual item é a página atual; sem isto, o destaque era
      // apenas visual.
      aria-current={ativo ? "page" : undefined}
      // Com a sidebar recolhida o rótulo some visualmente — o title supre o contexto
      // via tooltip nativo do navegador, sem precisar de um componente de tooltip novo.
      title={item.label}
    >
      <span aria-hidden="true" style={{ display: "flex" }}>
        {item.icon}
      </span>
      <span className={styles.navItemLabel}>{item.label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span className={styles.navBadge} aria-label={`${badge} pendente(s)`}>
          {badge}
        </span>
      )}
    </Link>
  );
}

// Correção do fluxo de Checklist: "Checklists NR-18/35" ganhou uma rota própria
// (/checklists) em vez de reaproveitar /reservas?status=agendada — não há mais dois itens
// do menu apontando para o mesmo pathname, então basta comparar o caminho.
function itemEstaAtivo(item: NavItem, pathname: string): boolean {
  return pathname === item.href;
}

export function Sidebar({ nome, perfil, badges }: SidebarProps) {
  const pathname = usePathname();
  const { collapsed } = useSidebarState();
  const itensVisiveis = NAV_ITEMS.filter((item) => !item.perfis || item.perfis.includes(perfil));
  const grupoOperacao = itensVisiveis.filter((item) => item.grupo === "operacao");
  const grupoAdministracao = itensVisiveis.filter((item) => item.grupo === "administracao");

  const badgeFor = (item: NavItem): number | undefined => {
    if (!item.badgeKey) return undefined;
    return badges?.[item.badgeKey];
  };

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      <div className={styles.brand}>
        <div className={styles.brandIcon}>PR</div>
        <div className={styles.brandText}>
          <span className={styles.brandName}>PlataformaRes</span>
          <span className={styles.brandSub}>Central de Operações</span>
        </div>
      </div>

      <nav className={styles.nav} aria-label="Navegação principal">
        <div className={styles.navGroup}>
          <span className={styles.navLabel}>{GRUPO_LABEL.operacao}</span>
          {grupoOperacao.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              ativo={itemEstaAtivo(item, pathname)}
              badge={badgeFor(item)}
            />
          ))}
        </div>

        {grupoAdministracao.length > 0 && (
          <div className={styles.navGroup}>
            <span className={styles.navLabel}>{GRUPO_LABEL.administracao}</span>
            {grupoAdministracao.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                ativo={itemEstaAtivo(item, pathname)}
                badge={badgeFor(item)}
              />
            ))}
          </div>
        )}
      </nav>

      <div className={styles.footer}>
        <SidebarUserMenu nome={nome} perfilLabel={PERFIL_LABEL[perfil]} />
      </div>
    </aside>
  );
}
