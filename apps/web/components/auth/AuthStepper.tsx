import styles from "./AuthStepper.module.css";

interface AuthStepperProps {
  etapas: string[];
  etapaAtual: number;
}

export function AuthStepper({ etapas, etapaAtual }: AuthStepperProps) {
  return (
    <ol className={styles.stepper} aria-label="Etapas do formulário">
      {etapas.map((etapa, indice) => {
        const estado = indice < etapaAtual ? "concluida" : indice === etapaAtual ? "atual" : "futura";
        return (
          <li
            key={etapa}
            className={styles.passo}
            data-estado={estado}
            aria-current={estado === "atual" ? "step" : undefined}
          >
            <span className={styles.circulo}>{indice + 1}</span>
            <span className={styles.rotulo}>{etapa}</span>
          </li>
        );
      })}
    </ol>
  );
}
