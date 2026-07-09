import { cookies } from "next/headers";
import styles from "./page.module.css";
import { TrocarSenhaForm } from "../../../components/TrocarSenhaForm";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3333";

export default async function ContaPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  const response = await fetch(`${API_URL}/api/v1/conta`, {
    headers: { cookie: `token=${token}` },
    cache: "no-store",
  });
  const usuario = await response.json();

  return (
    <section>
      <div className={styles.header}>
        <h1>Minha Conta</h1>
        <p>Seus dados e preferências de acesso</p>
      </div>

      <div className={styles.grid}>
        <div className={styles.panel}>
          <h2>Dados da conta</h2>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Nome</span>
            <span className={styles.infoValue}>{usuario.nome}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>E-mail</span>
            <span className={styles.infoValue}>{usuario.email}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Perfil</span>
            <span className={styles.infoValue}>{usuario.perfil === "admin" ? "Admin" : "Colaborador"}</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Último login</span>
            <span className={styles.infoValue}>
              {usuario.ultimoLogin ? new Date(usuario.ultimoLogin).toLocaleString("pt-BR") : "—"}
            </span>
          </div>
        </div>

        <div className={styles.panel}>
          <h2>Trocar senha</h2>
          <TrocarSenhaForm />
        </div>
      </div>
    </section>
  );
}
