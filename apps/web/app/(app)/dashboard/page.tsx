import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardClient } from "../../../components/DashboardClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

interface ContaResponse {
  id: string;
  nome: string;
  perfil: "admin" | "gestor_setor" | "colaborador";
}

function contaValida(valor: unknown): valor is ContaResponse {
  if (!valor || typeof valor !== "object") return false;

  const conta = valor as Record<string, unknown>;
  return (
    typeof conta.id === "string" &&
    typeof conta.nome === "string" &&
    conta.nome.trim().length > 0 &&
    (conta.perfil === "admin" || conta.perfil === "gestor_setor" || conta.perfil === "colaborador")
  );
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const headers = { cookie: `token=${token}` };

  const usuarioRes = await fetch(`${API_URL}/api/v1/conta`, { headers, cache: "no-store" }).catch(() => null);

  if (!usuarioRes?.ok) {
    redirect("/login");
  }

  const usuario: unknown = await usuarioRes.json();

  // Não deixe um payload de erro ou incompleto atravessar a fronteira servidor/cliente:
  // `DashboardClient` precisa desses campos para montar a saudação e filtrar os painéis.
  if (!contaValida(usuario)) {
    redirect("/login");
  }

  return (
    <DashboardClient
      usuarioId={usuario.id}
      usuarioNome={usuario.nome}
      perfil={usuario.perfil}
    />
  );
}
