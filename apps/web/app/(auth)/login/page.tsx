"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "../form.module.css";
import { apiFetch } from "../../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      await apiFetch("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, senha }),
      });
      router.push("/dashboard");
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao entrar.");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <>
      <h1 className={styles.title}>Entrar</h1>
      <p className={styles.subtitle}>Acesse com seu e-mail corporativo MetalSider</p>

      <form className={styles.form} onSubmit={handleSubmit}>
        {erro && <div className={styles.error}>{erro}</div>}

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
          <label htmlFor="senha">Senha</label>
          <input
            id="senha"
            type="password"
            placeholder="••••••••"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            required
          />
        </div>

        <button className={styles.submit} type="submit" disabled={carregando}>
          {carregando ? "Entrando..." : "Entrar"}
        </button>
      </form>

      <div className={styles.footerLinks}>
        <a href="/recuperar-senha">Esqueci minha senha</a>
        <a href="/ativar-conta">Ativar conta</a>
      </div>
    </>
  );
}
