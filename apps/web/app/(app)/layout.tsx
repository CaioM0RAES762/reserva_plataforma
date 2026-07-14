import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "../../components/Sidebar";
import { AppShell } from "../../components/AppShell";
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
  const response = await fetch(`${API_URL}/api/v1/conta`, { headers, cache: "no-store" });

  if (!response.ok) {
    redirect("/login");
  }

  const usuario = (await response.json()) as ContaResponse;

  const kpisResponse = await fetch(`${API_URL}/api/v1/dashboard/kpis`, { headers, cache: "no-store" }).catch(() => null);
  const kpis = kpisResponse?.ok ? ((await kpisResponse.json()) as KpisResponse) : null;
  const badges = kpis
    ? { frota: kpis.totalPlataformas, aprovacoes: kpis.pendenciasAprovacao, checklists: kpis.checklistsPendentes }
    : undefined;

  return (
    <>
      {/* S14 (RNF-04): abaixo de 900px a sidebar vira off-canvas — controlada por este
          checkbox (técnica CSS-only, sem JS/estado), alternado pelo botão ☰ no Topbar
          (label[for]) e fechável tocando no backdrop (também um label[for]). */}
      <input type="checkbox" id="sidebar-toggle" className={styles.sidebarToggleInput} />
      <label htmlFor="sidebar-toggle" className={styles.sidebarBackdrop} aria-hidden="true" />
      <Sidebar nome={usuario.nome} perfil={usuario.perfil} badges={badges} />
      <AppShell nome={usuario.nome} perfil={usuario.perfil}>{children}</AppShell>
    </>
  );
}
