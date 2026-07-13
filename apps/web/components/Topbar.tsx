"use client";

import { useRouter } from "next/navigation";
import styles from "./Topbar.module.css";
import { apiFetch } from "../lib/api";
import { NotificationBell } from "./NotificationBell";

export interface TopbarProps {
  titulo: string;
}

export function Topbar({ titulo }: TopbarProps) {
  const router = useRouter();
  const dataAtual = new Date().toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

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
      <div className={styles.title}>{titulo}</div>
      <div className={styles.actions}>
        <span className={styles.date}>{dataAtual}</span>
        <NotificationBell />
        <a className={styles.accountLink} href="/conta">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
          </svg>
          Minha Conta
        </a>
        <button className={styles.logoutBtn} onClick={handleLogout}>
          Sair
        </button>
      </div>
    </header>
  );
}
