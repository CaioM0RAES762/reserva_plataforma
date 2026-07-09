import styles from "./StatusBadge.module.css";

const STATUS_LABELS: Record<string, string> = {
  disponivel: "Disponível",
  reservada: "Reservada",
  manutencao: "Em Manutenção",
  inativa: "Inativa",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`${styles.badge} ${styles[status] ?? ""}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
