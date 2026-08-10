import styles from "./PasswordStrength.module.css";

// Espelha exatamente senhaSchema (packages/shared/src/schemas/auth.ts, RN-AUTH-01).
// Só feedback visual: a validação que vale é sempre a do backend.
const REGRAS = [
  (senha: string) => senha.length >= 8,
  (senha: string) => /[A-Z]/.test(senha),
  (senha: string) => /[a-z]/.test(senha),
  (senha: string) => /[0-9]/.test(senha),
];

const ROTULOS = ["", "Fraca", "Regular", "Boa", "Forte"];

export function senhaAtendeRequisitos(senha: string): boolean {
  return REGRAS.every((regra) => regra(senha));
}

export function PasswordStrength({ senha }: { senha: string }) {
  const atendidas = REGRAS.filter((regra) => regra(senha)).length;
  const rotulo = senha ? ROTULOS[atendidas] : "";

  return (
    <div>
      <div className={styles.barras} aria-hidden="true">
        {REGRAS.map((_, indice) => (
          <span key={indice} className={indice < atendidas ? styles.segmentoAtivo : styles.segmento} />
        ))}
      </div>
      <p className={styles.texto} aria-live="polite">
        Mín. 8 caracteres, com maiúscula, minúscula e número.
        {rotulo && ` · ${rotulo}`}
      </p>
    </div>
  );
}
