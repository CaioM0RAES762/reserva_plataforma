import Link from "next/link";
import { AuthSidePanel } from "../../components/auth/AuthSidePanel";
import styles from "./layout.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <div className={styles.formColumn}>
        <header>
          <Link href="/login" className={styles.brand}>
            <span className={styles.brandIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2.5" y="4" width="19" height="13" rx="1.5" />
                <path d="M8 20.5h8" strokeLinecap="round" />
              </svg>
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>PlataformaRes</span>
              <span className={styles.brandSub}>Gestão de equipamentos</span>
            </span>
          </Link>
        </header>

        <div className={styles.formArea}>
          <div className={styles.formSlot}>{children}</div>
        </div>

        <footer className={styles.legalFooter}>
          MetalSider · Sistema de gerenciamento operaciona de reservas.
        </footer>
      </div>

      {/* Painel institucional: decorativo em relação à autenticação — quem navega por
          teclado ou leitor de tela vai direto ao formulário. */}
      <aside className={styles.sidePanelWrap} aria-hidden="true">
        <AuthSidePanel />
      </aside>
    </div>
  );
}
