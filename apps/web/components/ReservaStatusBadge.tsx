import styles from "./ReservaStatusBadge.module.css";

const STATUS_LABELS: Record<string, string> = {
  pendente: "Pendente",
  agendada: "Agendada",
  em_uso: "Em Uso",
  concluida: "Concluída",
  cancelada: "Cancelada",
  rejeitada: "Rejeitada",
};

export function ReservaStatusBadge({ status }: { status: string }) {
  return (
    <span className={`${styles.badge} ${styles[status] ?? ""}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
