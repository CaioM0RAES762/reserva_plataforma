import styles from "./PriorityBadge.module.css";

const PRIORITY_LABELS: Record<string, string> = {
  normal: "Normal",
  alta: "Alta",
  urgente: "Urgente",
};

export function PriorityBadge({ prioridade }: { prioridade: string }) {
  return (
    <span className={`${styles.badge} ${styles[prioridade] ?? ""}`}>
      {PRIORITY_LABELS[prioridade] ?? prioridade}
    </span>
  );
}
