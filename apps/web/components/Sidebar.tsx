"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Construction,
  Ban,
  CalendarClock,
  CalendarDays,
  History,
  BarChart3,
  TriangleAlert,
  Users,
  Building2,
  Settings,
  FileSearch,
  X,
} from "lucide-react";
import styles from "./Sidebar.module.css";
import { SIDEBAR_DRAWER_ID, useSidebarState } from "./SidebarState";
import { SidebarUserMenu } from "./SidebarUserMenu";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  grupo: "operacao" | "administracao";
  perfis?: Array<"admin" | "gestor_setor" | "colaborador">;
  badgeKey?: "frota";
}

const ICON_PROPS = { size: 18, strokeWidth: 1.75 };

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Central de Operações", grupo: "operacao", icon: <LayoutDashboard {...ICON_PROPS} /> },
  { href: "/plataformas", label: "Frota", grupo: "operacao", icon: <Construction {...ICON_PROPS} />, badgeKey: "frota" },
  { href: "/reservas", label: "Reservas", grupo: "operacao", icon: <CalendarClock {...ICON_PROPS} /> },
  { href: "/calendario", label: "Calendário", grupo: "operacao", icon: <CalendarDays {...ICON_PROPS} /> },
  {
    href: "/plataformas/bloqueios",
    label: "Bloqueios de Agenda",
    grupo: "operacao",
    perfis: ["admin"],
    icon: <Ban {...ICON_PROPS} />,
  },
  { href: "/historico", label: "Histórico", grupo: "operacao", icon: <History {...ICON_PROPS} /> },
  {
    href: "/nao-conformidades",
    label: "Não conformidades",
    grupo: "operacao",
    icon: <TriangleAlert {...ICON_PROPS} />,
  },
  {
    href: "/relatorios",
    label: "Relatórios",
    grupo: "operacao",
    perfis: ["admin", "gestor_setor"],
    icon: <BarChart3 {...ICON_PROPS} />,
  },
  {
    href: "/administracao/auditoria",
    label: "Auditoria",
    grupo: "operacao",
    perfis: ["admin"],
    icon: <FileSearch {...ICON_PROPS} />,
  },
  {
    href: "/administracao/setores",
    label: "Setores",
    grupo: "administracao",
    perfis: ["admin"],
    icon: <Building2 {...ICON_PROPS} />,
  },
  {
    href: "/administracao/usuarios",
    label: "Usuários",
    grupo: "administracao",
    perfis: ["admin"],
    icon: <Users {...ICON_PROPS} />,
  },
  {
    href: "/administracao/configuracoes",
    label: "Configurações",
    grupo: "administracao",
    perfis: ["admin"],
    icon: <Settings {...ICON_PROPS} />,
  },
];

const GRUPO_LABEL: Record<NavItem["grupo"], string> = {
  operacao: "Operação",
  administracao: "Administração",
};

/* "Fila de Aprovações" e "Checklists NR-18/35" saíram da navegação junto com o fluxo de
 * aprovação e com o desacoplamento do checklist (migration 0018). Nenhuma das duas telas
 * tinha finalidade fora daquele fluxo: a fila seria permanentemente vazia, e o checklist
 * deixou de ser etapa da reserva. Manter um item de menu que só sabe mostrar "0" é pior do
 * que não ter o item. */
export interface SidebarBadges {
  frota?: number;
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

// Tooltip da sidebar recolhida: dispara no hover e no foco por teclado.
interface DicaHandlers {
  mostrar: (el: HTMLElement, texto: string) => void;
  esconder: () => void;
}

function NavLink({
  item,
  ativo,
  badge,
  aoNavegar,
  dica,
}: {
  item: NavItem;
  ativo: boolean;
  badge?: number;
  aoNavegar: () => void;
  dica: DicaHandlers;
}) {
  return (
    <Link
      href={item.href}
      className={`${styles.navItem} ${ativo ? styles.active : ""}`}
      // Fecha o drawer mobile ao escolher uma rota. A troca de pathname já fecha, mas
      // clicar no item da página em que o usuário já está não muda o pathname — sem isto o
      // drawer ficaria aberto sobre a tela que ele acabou de "escolher".
      onClick={aoNavegar}
      // Leitores de tela anunciam qual item é a página atual; sem isto, o destaque era
      // apenas visual.
      aria-current={ativo ? "page" : undefined}
      // Com a sidebar recolhida o rótulo some visualmente (continua no DOM como nome
      // acessível) e o contexto vem do tooltip da própria sidebar.
      onMouseEnter={(e) => dica.mostrar(e.currentTarget, item.label)}
      onMouseLeave={dica.esconder}
      onFocus={(e) => dica.mostrar(e.currentTarget, item.label)}
      onBlur={dica.esconder}
    >
      <span aria-hidden="true" style={{ display: "flex" }}>
        {item.icon}
      </span>
      <span className={styles.navItemLabel}>{item.label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span className={styles.navBadge} aria-label={`${badge} pendente${badge > 1 ? "s" : ""}`}>
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
  const { collapsed, mobileAberto, fecharMobile, gatilhoMobileRef } = useSidebarState();
  const [dicaAtual, setDicaAtual] = useState<{ texto: string; top: number; left: number } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const fecharBtnRef = useRef<HTMLButtonElement>(null);
  const jaAbriuRef = useRef(false);
  const itensVisiveis = NAV_ITEMS.filter((item) => !item.perfis || item.perfis.includes(perfil));
  const grupoOperacao = itensVisiveis.filter((item) => item.grupo === "operacao");
  const grupoAdministracao = itensVisiveis.filter((item) => item.grupo === "administracao");

  // Tooltip só existe na coluna recolhida do desktop — expandida (ou no drawer) o rótulo já
  // está visível. position:fixed, fora do <aside>, porque o overflow da sidebar o cortaria.
  const dica: DicaHandlers = {
    mostrar: (el, texto) => {
      if (!collapsed || window.matchMedia("(max-width: 900px)").matches) return;
      const rect = el.getBoundingClientRect();
      setDicaAtual({ texto, top: rect.top + rect.height / 2, left: rect.right + 10 });
    },
    esconder: () => setDicaAtual(null),
  };

  useEffect(() => {
    setDicaAtual(null);
  }, [collapsed, pathname]);

  const badgeFor = (item: NavItem): number | undefined => {
    if (!item.badgeKey) return undefined;
    return badges?.[item.badgeKey];
  };

  // Foco do drawer: ao abrir, vai para o botão fechar (primeiro controle do drawer; sem
  // isso o foco ficaria no hambúrguer, agora atrás do overlay); ao fechar, volta ao
  // hambúrguer que o abriu. `jaAbriuRef` impede que a montagem inicial (drawer fechado)
  // roube o foco da página. No desktop `mobileAberto` nunca muda, então nada disto roda.
  useEffect(() => {
    if (mobileAberto) {
      jaAbriuRef.current = true;
      fecharBtnRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!jaAbriuRef.current) return;
    jaAbriuRef.current = false;
    // Se o viewport cruzou para desktop, o hambúrguer está display:none e focus() é no-op.
    gatilhoMobileRef.current?.focus({ preventScroll: true });
  }, [mobileAberto, gatilhoMobileRef]);

  // Prende o Tab dentro do drawer enquanto aberto: o conteúdo atrás está inerte (ver
  // AppShell), então sem a armadilha o Tab escaparia para a interface do navegador. O
  // popover do menu do usuário também vive dentro do <aside>, portanto entra na lista.
  function aoTeclar(evento: KeyboardEvent<HTMLElement>) {
    if (!mobileAberto || evento.key !== "Tab") return;
    const focaveis = asideRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    if (!focaveis || focaveis.length === 0) return;
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (evento.shiftKey && document.activeElement === primeiro) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primeiro.focus();
    }
  }

  return (
    <>
      {/* Overlay do drawer mobile (display:none no desktop). É um <button> e não um <div
          onClick> para o toque funcionar em qualquer navegador móvel (o iOS não dispara
          click em div sem cursor:pointer). Fica fora da ordem de tabulação e do leitor de
          tela: ESC e o botão "Fechar menu" já cobrem teclado e tecnologia assistiva. */}
      <button
        type="button"
        className={styles.backdrop}
        onClick={fecharMobile}
        tabIndex={-1}
        aria-hidden="true"
        data-sidebar-backdrop=""
        data-mobile-open={mobileAberto}
      />
      <aside
        ref={asideRef}
        id={SIDEBAR_DRAWER_ID}
        className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}
        data-mobile-open={mobileAberto}
        onKeyDown={aoTeclar}
      >
        <div className={styles.brand}>
          <div className={styles.brandIcon}>PR</div>
          <div className={styles.brandText}>
            <span className={styles.brandName}>PlataformaRes</span>
            <span className={styles.brandSub}>Central de Operações</span>
          </div>
          {/* Só aparece no drawer (<=900px) — no desktop o recolher fica no Topbar. */}
          <button
            type="button"
            ref={fecharBtnRef}
            className={styles.closeBtn}
            onClick={fecharMobile}
            aria-label="Fechar menu"
            data-sidebar-close=""
          >
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <nav className={styles.nav} aria-label="Navegação principal" onScroll={dica.esconder}>
          <div className={styles.navGroup}>
            <span className={styles.navLabel}>{GRUPO_LABEL.operacao}</span>
            {grupoOperacao.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                ativo={itemEstaAtivo(item, pathname)}
                badge={badgeFor(item)}
                aoNavegar={fecharMobile}
                dica={dica}
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
                  aoNavegar={fecharMobile}
                  dica={dica}
                />
              ))}
            </div>
          )}
        </nav>

        <div className={styles.footer}>
          <SidebarUserMenu nome={nome} perfilLabel={PERFIL_LABEL[perfil]} />
        </div>
      </aside>
      {dicaAtual && (
        <div className={styles.dica} role="tooltip" style={{ top: dicaAtual.top, left: dicaAtual.left }}>
          {dicaAtual.texto}
        </div>
      )}
    </>
  );
}
