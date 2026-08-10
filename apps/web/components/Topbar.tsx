"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Radio, UserCircle } from "lucide-react";
import styles from "./Topbar.module.css";
import { apiFetch } from "../lib/api";
import { NotificationBell } from "./NotificationBell";

export interface TopbarProps {
  titulo: string;
  nome?: string;
  perfilLabel?: string;
}

function formatarRelogio(data: Date): string {
  const dia = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(".", "");
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${dia.toUpperCase()} · ${hora} BRT`;
}

export function Topbar({ titulo, nome, perfilLabel }: TopbarProps) {
  const router = useRouter();
  const [agora, setAgora] = useState<Date | null>(null);
  const [menuAberto, setMenuAberto] = useState(false);
  const [saindo, setSaindo] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Renderizado só no cliente: o relógio do servidor difere do relógio do usuário e
    // causaria divergência de hidratação.
    setAgora(new Date());
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Fecha o menu ao clicar fora ou apertar ESC — comportamento esperado de qualquer menu.
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

  const iniciais = nome
    ? nome
        .split(" ")
        .map((parte) => parte[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : undefined;

  async function handleLogout() {
    setSaindo(true);
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Mesmo se a chamada falhar, segue para o login: o cookie pode já ter expirado.
    } finally {
      // `refresh()` descarta o cache do App Router — sem ele, voltar no navegador
      // reexibia as páginas autenticadas renderizadas antes do logout.
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <header className={styles.topbar}>
      {/* S14 (RNF-04): abre a sidebar off-canvas abaixo de 900px — alterna o checkbox
          #sidebar-toggle (renderizado em app/(app)/layout.tsx) via label[for], sem JS. */}
      <label htmlFor="sidebar-toggle" className={styles.hamburger} aria-label="Abrir menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </label>

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

        {/* Menu da conta. Estava ausente: o app não tinha NENHUM caminho para sair da
            sessão nem para abrir "Minha Conta" — a rota /conta existia, mas nada no
            layout apontava para ela, e o botão "Sair" havia sumido do Topbar. */}
        {nome && (
          <>
            <span className={styles.divider} aria-hidden="true" />
            <div className={styles.userBlock} ref={menuRef}>
              <button
                type="button"
                className={styles.userTrigger}
                onClick={() => setMenuAberto((aberto) => !aberto)}
                aria-haspopup="menu"
                aria-expanded={menuAberto}
                aria-label={`Conta de ${nome}`}
                data-testid="user-menu-trigger"
              >
                <span className={styles.userInfo}>
                  <span className={styles.userName}>{nome}</span>
                  {perfilLabel && <span className={styles.userRole}>{perfilLabel}</span>}
                </span>
                <span className={styles.userAvatar} aria-hidden="true">
                  {iniciais}
                </span>
              </button>

              {menuAberto && (
                <div className={styles.userMenu} role="menu" data-testid="user-menu">
                  <Link
                    href="/conta"
                    className={styles.userMenuItem}
                    role="menuitem"
                    onClick={() => setMenuAberto(false)}
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
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
