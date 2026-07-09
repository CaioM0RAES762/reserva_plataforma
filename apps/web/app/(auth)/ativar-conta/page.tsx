"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "../form.module.css";
import { apiFetch } from "../../../lib/api";

export default function AtivarContaPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [codigo, setCodigo] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState(false);
  const [carregando, setCarregando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      await apiFetch("/api/v1/auth/ativar-conta", {
        method: "POST",
        body: JSON.stringify({ email, codigo, senha }),
      });
      setSucesso(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao ativar conta.");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <>
      <h1 className={styles.title}>Ativar conta</h1>
      <p className={styles.subtitle}>
        Informe o código de 6 dígitos enviado ao seu e-mail e defina sua senha.
      </p>

      <form className={styles.form} onSubmit={handleSubmit}>
        {erro && <div className={styles.error}>{erro}</div>}
        {sucesso && <div className={styles.success}>Conta ativada com sucesso. Redirecionando...</div>}

        <div className={styles.group}>
          <label htmlFor="email">E-mail</label>
          <input
            id="email"
            type="email"
            placeholder="nome@metalsider.com.br"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className={styles.group}>
          <label htmlFor="codigo">Código de verificação</label>
          <input
            id="codigo"
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
            required
          />
          <span className={styles.hint}>Válido por 15 minutos, uso único.</span>
        </div>

        <div className={styles.group}>
          <label htmlFor="senha">Nova senha</label>
          <input
            id="senha"
            type="password"
            placeholder="••••••••"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
          <span className={styles.hint}>Mín. 8 caracteres, com maiúscula, minúscula e número.</span>
        </div>

        <button className={styles.submit} type="submit" disabled={carregando}>
          {carregando ? "Ativando..." : "Ativar conta"}
        </button>
      </form>

      <div className={styles.footerLinks}>
        <a href="/login">Voltar ao login</a>
      </div>
    </>
  );
}
