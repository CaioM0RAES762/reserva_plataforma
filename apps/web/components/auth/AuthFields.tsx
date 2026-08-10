"use client";

import { useId, useState, type ReactNode } from "react";
import styles from "./AuthForm.module.css";

/* Campos do formulário de autenticação. Todos seguem a mesma anatomia da referência:
   label-eyebrow → controle (field-base) → hint/erro opcional. */

interface CampoBaseProps {
  id?: string;
  label: string;
  hint?: ReactNode;
  erro?: string | null;
}

function useCampoIds(idFornecido: string | undefined) {
  const gerado = useId();
  const id = idFornecido ?? gerado;
  return { id, descricaoId: `${id}-descricao` };
}

/* ── Texto / e-mail ───────────────────────────────────────────────────────── */
interface TextFieldProps extends CampoBaseProps {
  value: string;
  onChange: (valor: string) => void;
  type?: "text" | "email";
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
  inputMode?: "text" | "email";
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  autoFocus,
  required = true,
  disabled,
  inputMode,
  hint,
  erro,
}: TextFieldProps) {
  const { id: inputId, descricaoId } = useCampoIds(id);
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.labelEyebrow}>
        {label}
      </label>
      <span className={styles.controlWrap}>
        <input
          id={inputId}
          className={styles.inputBase}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro || hint ? descricaoId : undefined}
        />
      </span>
      {erro ? (
        <span id={descricaoId} className={styles.fieldError} role="alert">
          {erro}
        </span>
      ) : hint ? (
        <span id={descricaoId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ── Select ───────────────────────────────────────────────────────────────── */
interface SelectFieldProps extends CampoBaseProps {
  value: string;
  onChange: (valor: string) => void;
  opcoes: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  opcoes,
  placeholder = "Selecione…",
  required = true,
  disabled,
  hint,
  erro,
}: SelectFieldProps) {
  const { id: inputId, descricaoId } = useCampoIds(id);
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.labelEyebrow}>
        {label}
      </label>
      <span className={styles.controlWrap}>
        <select
          id={inputId}
          className={styles.inputBase}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          disabled={disabled}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro || hint ? descricaoId : undefined}
        >
          <option value="">{placeholder}</option>
          {opcoes.map((opcao) => (
            <option key={opcao.value} value={opcao.value}>
              {opcao.label}
            </option>
          ))}
        </select>
      </span>
      {erro ? (
        <span id={descricaoId} className={styles.fieldError} role="alert">
          {erro}
        </span>
      ) : hint ? (
        <span id={descricaoId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ── Senha ────────────────────────────────────────────────────────────────── */
interface PasswordFieldProps extends CampoBaseProps {
  value: string;
  onChange: (valor: string) => void;
  autoComplete?: "current-password" | "new-password";
  autoFocus?: boolean;
  disabled?: boolean;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete = "current-password",
  autoFocus,
  disabled,
  hint,
  erro,
}: PasswordFieldProps) {
  const { id: inputId, descricaoId } = useCampoIds(id);
  const [mostrar, setMostrar] = useState(false);
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.labelEyebrow}>
        {label}
      </label>
      <span className={styles.controlWrap}>
        <span className={styles.passwordWrap}>
          <input
            id={inputId}
            className={styles.inputBase}
            type={mostrar ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="••••••••"
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            disabled={disabled}
            required
            aria-invalid={erro ? true : undefined}
            aria-describedby={erro || hint ? descricaoId : undefined}
          />
          <button
            type="button"
            className={styles.toggleSenha}
            onClick={() => setMostrar((atual) => !atual)}
            aria-pressed={mostrar}
            aria-label={mostrar ? "Ocultar senha" : "Mostrar senha"}
          >
            {mostrar ? "Ocultar" : "Mostrar"}
          </button>
        </span>
      </span>
      {erro ? (
        <span id={descricaoId} className={styles.fieldError} role="alert">
          {erro}
        </span>
      ) : hint ? (
        <span id={descricaoId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ── Código de verificação ────────────────────────────────────────────────── */
interface CodeFieldProps extends CampoBaseProps {
  value: string;
  onChange: (valor: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function CodeField({ id, label, value, onChange, disabled, autoFocus, hint, erro }: CodeFieldProps) {
  const { id: inputId, descricaoId } = useCampoIds(id);
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.labelEyebrow}>
        {label}
      </label>
      <span className={styles.controlWrap}>
        <input
          id={inputId}
          className={`${styles.inputBase} ${styles.codeInput}`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={value}
          // Filtra não-dígitos aqui para o campo aceitar código colado com espaços ou
          // traços ("248 572", "248-572") sem obrigar o usuário a limpar na mão.
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          disabled={disabled}
          autoFocus={autoFocus}
          required
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro || hint ? descricaoId : undefined}
        />
      </span>
      {erro ? (
        <span id={descricaoId} className={styles.fieldError} role="alert">
          {erro}
        </span>
      ) : hint ? (
        <span id={descricaoId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
