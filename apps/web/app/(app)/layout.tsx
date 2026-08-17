import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "../../components/Sidebar";
import { AppShell } from "../../components/AppShell";
import { SidebarStateProvider } from "../../components/SidebarState";
import styles from "../../components/Sidebar.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

interface ContaResponse {
  nome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
}

interface KpisResponse {
  totalPlataformas: number;
  pendenciasAprovacao: number;
  checklistsPendentes: number;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;

  if (!token) {
    redirect("/login");
  }

  const headers = { cookie: `token=${token}` };

  // As duas chamadas eram sequenciais: cada navegação entre páginas autenticadas pagava
  // dois round-trips em série no servidor antes de renderizar qualquer coisa. Elas são
  // independentes — a de KPIs não usa nada da resposta de /conta —, então rodam juntas e
  // o layout passa a custar um round-trip. `catch` no lugar do `.ok` mantém o
  // comportamento anterior: falha de KPI só remove os badges, nunca derruba a página.
  const [contaResponse, kpisResponse] = await Promise.all([
    fetch(`${API_URL}/api/v1/conta`, { headers, cache: "no-store" }).catch(() => null),
    fetch(`${API_URL}/api/v1/dashboard/kpis`, { headers, cache: "no-store" }).catch(() => null),
  ]);

  if (!contaResponse?.ok) {
    redirect("/login");
  }

  const usuario = (await contaResponse.json()) as ContaResponse;
  const kpis = kpisResponse?.ok ? ((await kpisResponse.json()) as KpisResponse) : null;
  const badges = kpis
    ? { frota: kpis.totalPlataformas, aprovacoes: kpis.pendenciasAprovacao, checklists: kpis.checklistsPendentes }
    : undefined;

  return (
    // Fonte única do estado de colapso do desktop (Sidebar, Topbar e AppShell leem o
    // mesmo contexto) — ver components/SidebarState.tsx. Não interfere no off-canvas
    // mobile abaixo, que continua CSS-only via o checkbox #sidebar-toggle.
    <SidebarStateProvider>
      {/* Primeiro elemento focável da página: quem navega por teclado pula a sidebar
          inteira (14 links) em vez de tabular por ela em toda troca de tela. */}
      <a href="#conteudo-principal" className={styles.skipLink}>
        Pular para o conteúdo
      </a>
      {/* S14 (RNF-04): abaixo de 900px a sidebar vira off-canvas — controlada por este
          checkbox (técnica CSS-only, sem JS/estado), alternado pelo botão ☰ no Topbar
          (label[for]) e fechável tocando no backdrop (também um label[for]). */}
      <input type="checkbox" id="sidebar-toggle" className={styles.sidebarToggleInput} />
      <label htmlFor="sidebar-toggle" className={styles.sidebarBackdrop} aria-hidden="true" />
      <Sidebar nome={usuario.nome} perfil={usuario.perfil} badges={badges} />
      <AppShell perfil={usuario.perfil}>{children}</AppShell>
    </SidebarStateProvider>
  );
}
