import { cookies } from "next/headers";
import Link from "next/link";
import styles from "./page.module.css";
import { StatusBadge } from "../../../components/StatusBadge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3333";

interface Kpis {
  totalPlataformas: number;
  disponiveis: number;
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  status: string;
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const headers = { cookie: `token=${token}` };

  const [usuarioRes, kpisRes, plataformasRes] = await Promise.all([
    fetch(`${API_URL}/api/v1/conta`, { headers, cache: "no-store" }),
    fetch(`${API_URL}/api/v1/dashboard/kpis`, { headers, cache: "no-store" }),
    fetch(`${API_URL}/api/v1/plataformas`, { headers, cache: "no-store" }),
  ]);

  const usuario = await usuarioRes.json();
  const kpis: Kpis = await kpisRes.json();
  const plataformas: Plataforma[] = await plataformasRes.json();

  return (
    <section>
      <div className={styles.header}>
        <h1>Visão Geral</h1>
        <p>Bem-vindo(a), {usuario.nome}</p>
      </div>

      <div className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue}>{kpis.totalPlataformas}</span>
          <span className={styles.kpiLabel}>Plataformas</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue}>{kpis.disponiveis}</span>
          <span className={styles.kpiLabel}>Disponíveis</span>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2>Status das Plataformas</h2>
        </div>
        {plataformas.length === 0 ? (
          <div className={styles.empty}>Nenhuma plataforma cadastrada.</div>
        ) : (
          <div className={styles.statusGrid}>
            {plataformas.map((p) => (
              <Link key={p.id} href="/plataformas" className={styles.statusCard}>
                <span className={styles.statusCode}>{p.codigo}</span>
                <span className={styles.statusName}>{p.nome}</span>
                <span className={styles.statusLoc}>{p.localizacao ?? "—"}</span>
                <StatusBadge status={p.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
