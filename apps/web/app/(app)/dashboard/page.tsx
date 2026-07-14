import { cookies } from "next/headers";
import { DashboardClient } from "../../../components/DashboardClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const headers = { cookie: `token=${token}` };

  const usuarioRes = await fetch(`${API_URL}/api/v1/conta`, { headers, cache: "no-store" });
  const usuario = await usuarioRes.json();

  return (
    <DashboardClient
      usuarioId={usuario.id}
      usuarioNome={usuario.nome}
      perfil={usuario.perfil}
      setorNome={usuario.setorNome}
    />
  );
}
