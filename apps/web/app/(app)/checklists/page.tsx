import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ChecklistsClient } from "../../../components/ChecklistsClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export default async function ChecklistsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const response = await fetch(`${API_URL}/api/v1/conta`, {
    headers: { cookie: `token=${token}` },
    cache: "no-store",
  });

  if (!response.ok) {
    redirect("/login");
  }

  const usuario = await response.json();

  // `usuarioId` alimenta o destaque de "meu checklist" (comparação por id, nunca por nome);
  // `isAdmin` libera a ação administrativa "Gerenciar templates".
  return <ChecklistsClient usuarioId={usuario.id} isAdmin={usuario.perfil === "admin"} />;
}
