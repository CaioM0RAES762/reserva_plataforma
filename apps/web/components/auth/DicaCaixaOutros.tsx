import { Info } from "lucide-react";
import styles from "./AuthForm.module.css";

/* Dica exibida logo abaixo de "Enviamos um código…" nos fluxos com código por e-mail
 * (ativação e recuperação de senha). O Outlook da empresa costuma classificar o e-mail
 * automático na aba "Outros" em vez de "Destaques" — é dica, não erro: tom neutro, texto
 * real (não só ícone/cor) e sem role="alert". Em telas estreitas usa a versão curta. */
export function DicaCaixaOutros() {
  return (
    <p className={styles.dicaOutros} data-testid="dica-outlook-outros">
      <Info size={15} aria-hidden="true" className={styles.dicaOutrosIcone} />
      <span className={styles.dicaOutrosLonga}>
        Não encontrou o e-mail? No Outlook, confira também a aba <strong>Outros</strong> — ele pode
        não aparecer em Destaques.
      </span>
      <span className={styles.dicaOutrosCurta}>
        Não encontrou o código? Confira também a aba <strong>Outros</strong> do Outlook.
      </span>
    </p>
  );
}
