import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { RelatoriosClient } from "../../../components/RelatoriosClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export default async function RelatoriosPage() {
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
  if (usuario.perfil !== "admin" && usuario.perfil !== "gestor_setor") {
    redirect("/dashboard");
  }

  return <RelatoriosClient perfil={usuario.perfil} />;
}
