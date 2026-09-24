import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "../../components/Sidebar";
import { AppShell } from "../../components/AppShell";
import { SidebarStateProvider } from "../../components/SidebarState";
import { TrocaSenhaObrigatoriaGate } from "../../components/TrocaSenhaObrigatoriaGate";
import styles from "../../components/Sidebar.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

interface ContaResponse {
  nome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
  senhaProvisoria?: boolean;
}

interface KpisResponse {
  totalPlataformas: number;
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

  // Senha provisória (Admin → Novo Usuário → "metal@40"): bloqueia TODO o app até a troca,
  // antes de montar sidebar/KPIs — nenhuma tela por trás do gate chega a renderizar.
  if (usuario.senhaProvisoria) {
    return <TrocaSenhaObrigatoriaGate />;
  }

  const kpis = kpisResponse?.ok ? ((await kpisResponse.json()) as KpisResponse) : null;
  const badges = kpis
    ? { frota: kpis.totalPlataformas }
    : undefined;

  return (
    // Fonte única do estado da sidebar (colapso no desktop e drawer no mobile: Sidebar,
    // Topbar e AppShell leem o mesmo contexto) — ver components/SidebarState.tsx.
    <SidebarStateProvider>
      {/* Primeiro elemento focável da página: quem navega por teclado pula a sidebar
          inteira (14 links) em vez de tabular por ela em toda troca de tela. */}
      <a href="#conteudo-principal" className={styles.skipLink}>
        Pular para o conteúdo
      </a>
      {/* S14 (RNF-04): abaixo de 900px a sidebar vira drawer off-canvas. Overlay, botão de
          fechar e <aside> são um único componente (Sidebar) controlado pelo estado React do
          SidebarState — o mesmo <aside> serve desktop e drawer, sem menu duplicado. */}
      <Sidebar nome={usuario.nome} perfil={usuario.perfil} badges={badges} />
      <AppShell perfil={usuario.perfil}>{children}</AppShell>
    </SidebarStateProvider>
  );
}
