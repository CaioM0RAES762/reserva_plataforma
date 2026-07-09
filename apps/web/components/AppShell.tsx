"use client";

import { usePathname } from "next/navigation";
import styles from "./Topbar.module.css";
import { Topbar } from "./Topbar";

const TITULOS: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/conta": "Minha Conta",
  "/plataformas": "Plataformas",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const titulo = TITULOS[pathname] ?? "PlataformaRes";

  return (
    <div className={styles.wrapper}>
      <Topbar titulo={titulo} />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
