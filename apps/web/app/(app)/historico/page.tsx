import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { HistoricoClient } from "../../../components/HistoricoClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";

export default async function HistoricoPage() {
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

  return <HistoricoClient perfil={usuario.perfil} setorId={usuario.setorId} />;
}
