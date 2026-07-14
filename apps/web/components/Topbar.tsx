"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, User, Radio } from "lucide-react";
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

  useEffect(() => {
    setAgora(new Date());
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const iniciais = nome
    ? nome
        .split(" ")
        .map((parte) => parte[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : undefined;

  async function handleLogout() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // mesmo se a chamada falhar, seguimos para o login
    } finally {
      router.push("/login");
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
        <div className={styles.breadcrumb}>
          <span>CENTRAL</span>
          <span className={styles.breadcrumbSep}>›</span>
          <span className={styles.breadcrumbCurrent}>{titulo}</span>
        </div>
        <div className={styles.search}>
          <Search size={15} strokeWidth={1.75} className={styles.searchIcon} />
          <input type="text" placeholder="Buscar reserva, plataforma, colaborador..." className={styles.searchInput} />
          <kbd className={styles.kbd}>⌘K</kbd>
        </div>
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
        <span className={styles.divider} aria-hidden="true" />
        {nome && (
          <div className={styles.userBlock}>
          </div>
        )}
      </div>
    </header>
  );
}
