import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ReservasClient } from "../../../components/ReservasClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3334";

export default async function ReservasPage() {
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

  return (
    <ReservasClient
      solicitanteNome={usuario.nome}
      setorNome={usuario.setorNome}
      perfil={usuario.perfil}
      setorId={usuario.setorId}
    />
  );
}
