"use client";

import { useState, type FormEvent } from "react";
import styles from "../app/(app)/conta/page.module.css";
import { apiFetch } from "../lib/api";

export function TrocarSenhaForm() {
  const [senhaAtual, setSenhaAtual] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState(false);
  const [carregando, setCarregando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setSucesso(false);
    setCarregando(true);
    try {
      await apiFetch("/api/v1/conta/senha", {
        method: "PATCH",
        body: JSON.stringify({ senhaAtual, novaSenha }),
      });
      setSucesso(true);
      setSenhaAtual("");
      setNovaSenha("");
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao trocar senha.");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {erro && <div className={styles.error}>{erro}</div>}
      {sucesso && <div className={styles.success}>Senha alterada com sucesso.</div>}

      <div className={styles.group}>
        <label htmlFor="senhaAtual">Senha atual</label>
        <input
          id="senhaAtual"
          type="password"
          value={senhaAtual}
          onChange={(e) => setSenhaAtual(e.target.value)}
          required
        />
      </div>

      <div className={styles.group}>
        <label htmlFor="novaSenha">Nova senha</label>
        <input
          id="novaSenha"
          type="password"
          value={novaSenha}
          onChange={(e) => setNovaSenha(e.target.value)}
          required
        />
      </div>

      <button className={styles.submit} type="submit" disabled={carregando}>
        {carregando ? "Salvando..." : "Trocar senha"}
      </button>
    </form>
  );
}
