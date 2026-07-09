import styles from "./layout.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <div className={styles.brandIcon}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </div>
          <div className={styles.brandText}>
            <span className={styles.brandName}>PlataformaRes</span>
            <span className={styles.brandSub}>Gestão de Equipamentos</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
