import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "../../components/Sidebar";
import { AppShell } from "../../components/AppShell";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3333";

interface ContaResponse {
  nome: string;
  perfil: "admin" | "colaborador";
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;

  if (!token) {
    redirect("/login");
  }

  const response = await fetch(`${API_URL}/api/v1/conta`, {
    headers: { cookie: `token=${token}` },
    cache: "no-store",
  });

  if (!response.ok) {
    redirect("/login");
  }

  const usuario = (await response.json()) as ContaResponse;

  return (
    <>
      <Sidebar nome={usuario.nome} perfil={usuario.perfil} />
      <AppShell>{children}</AppShell>
    </>
  );
}
