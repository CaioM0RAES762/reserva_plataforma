"use client";

import { usePathname } from "next/navigation";
import styles from "./Topbar.module.css";
import { Topbar } from "./Topbar";

const TITULOS: Record<string, string> = {
  "/conta": "Minha Conta",
  "/plataformas": "Plataformas",
  "/reservas": "Reservas",
};

const PERFIL_LABEL: Record<string, string> = {
  admin: "Admin",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

const DASHBOARD_TITULO: Record<string, string> = {
  admin: "Visão do Administrador",
  gestor_setor: "Visão do Setor",
  colaborador: "Minhas Operações",
};

export interface AppShellProps {
  children: React.ReactNode;
  nome?: string;
  perfil?: "admin" | "gestor_setor" | "colaborador";
}

export function AppShell({ children, nome, perfil }: AppShellProps) {
  const pathname = usePathname();
  const titulo =
    pathname === "/dashboard" ? (perfil ? DASHBOARD_TITULO[perfil] : "Dashboard") : TITULOS[pathname] ?? "PlataformaRes";

  return (
    <div className={styles.wrapper}>
      <Topbar titulo={titulo} nome={nome} perfilLabel={perfil ? PERFIL_LABEL[perfil] : undefined} />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
