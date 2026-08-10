"use client";

import { usePathname } from "next/navigation";
import styles from "./Topbar.module.css";
import { Topbar } from "./Topbar";

// Mapa completo de rotas → título do breadcrumb. Antes cobria só três rotas (/conta,
// /plataformas, /reservas): todas as demais telas — Calendário, Histórico, Relatórios,
// Fila de Aprovações, Bloqueios, Painel TV e as quatro de Administração — exibiam o
// literal "PlataformaRes" no lugar do próprio nome, deixando o usuário sem referência de
// onde estava.
//
// Ordenado do mais específico para o mais genérico, porque a resolução é por prefixo:
// /reservas/aprovacoes precisa vencer /reservas.
const TITULOS: Array<[string, string]> = [
  ["/reservas/aprovacoes", "Fila de Aprovações"],
  ["/plataformas/bloqueios", "Bloqueios de Agenda"],
  ["/plataformas/painel-tv", "Painel TV"],
  ["/administracao/usuarios", "Usuários"],
  ["/administracao/setores", "Setores"],
  ["/administracao/configuracoes", "Configurações"],
  ["/administracao/auditoria", "Auditoria"],
  ["/plataformas", "Frota"],
  ["/reservas", "Reservas"],
  ["/calendario", "Calendário"],
  ["/historico", "Histórico"],
  ["/relatorios", "Relatórios"],
  ["/conta", "Minha Conta"],
];

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

function resolverTitulo(pathname: string, perfil?: AppShellProps["perfil"]): string {
  if (pathname === "/dashboard") {
    return perfil ? DASHBOARD_TITULO[perfil] : "Dashboard";
  }
  const encontrado = TITULOS.find(([prefixo]) => pathname === prefixo || pathname.startsWith(`${prefixo}/`));
  return encontrado ? encontrado[1] : "PlataformaRes";
}

export function AppShell({ children, nome, perfil }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className={styles.wrapper}>
      <Topbar
        titulo={resolverTitulo(pathname, perfil)}
        nome={nome}
        perfilLabel={perfil ? PERFIL_LABEL[perfil] : undefined}
      />
      {/* id de destino do link "pular para o conteúdo" (ver globals.css) — permite a quem
          navega por teclado saltar a sidebar inteira a cada troca de página. */}
      <main id="conteudo-principal" className={styles.content}>
        {children}
      </main>
    </div>
  );
}
