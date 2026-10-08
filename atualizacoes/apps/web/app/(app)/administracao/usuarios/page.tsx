import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { UsuariosClient } from "../../../../components/UsuariosClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export default async function UsuariosAdminPage() {
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
  // Gestor de Setor entra para consultar e cadastrar contas (Colaborador/Gestor).
  if (usuario.perfil !== "admin" && usuario.perfil !== "gestor_setor") {
    redirect("/dashboard");
  }

  return <UsuariosClient isAdmin={usuario.perfil === "admin"} />;
}
