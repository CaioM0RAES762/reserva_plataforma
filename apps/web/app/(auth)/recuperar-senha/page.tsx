"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "../form.module.css";
import { apiFetch } from "../../../lib/api";

export default function RecuperarSenhaPage() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<"solicitar" | "confirmar">("solicitar");
  const [email, setEmail] = useState("");
  const [codigo, setCodigo] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  async function handleSolicitar(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      const resposta = await apiFetch<{ mensagem: string }>("/api/v1/auth/recuperar-senha", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMensagem(resposta.mensagem);
      setEtapa("confirmar");
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao solicitar recuperação.");
    } finally {
      setCarregando(false);
    }
  }

  async function handleConfirmar(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      await apiFetch("/api/v1/auth/recuperar-senha/confirmar", {
        method: "POST",
        body: JSON.stringify({ email, codigo, novaSenha }),
      });
      setMensagem("Senha redefinida com sucesso. Redirecionando...");
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao redefinir senha.");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <>
      <h1 className={styles.title}>Recuperar senha</h1>
      <p className={styles.subtitle}>
        {etapa === "solicitar"
          ? "Informe seu e-mail corporativo para receber um código de verificação."
          : "Informe o código recebido e defina sua nova senha."}
      </p>

      {etapa === "solicitar" ? (
        <form className={styles.form} onSubmit={handleSolicitar}>
          {erro && <div className={styles.error}>{erro}</div>}
          {mensagem && <div className={styles.success}>{mensagem}</div>}

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

          <button className={styles.submit} type="submit" disabled={carregando}>
            {carregando ? "Enviando..." : "Enviar código"}
          </button>
        </form>
      ) : (
        <form className={styles.form} onSubmit={handleConfirmar}>
          {erro && <div className={styles.error}>{erro}</div>}
          {mensagem && <div className={styles.success}>{mensagem}</div>}

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
          </div>

          <div className={styles.group}>
            <label htmlFor="novaSenha">Nova senha</label>
            <input
              id="novaSenha"
              type="password"
              placeholder="••••••••"
              value={novaSenha}
              onChange={(e) => setNovaSenha(e.target.value)}
              required
            />
            <span className={styles.hint}>Mín. 8 caracteres, com maiúscula, minúscula e número.</span>
          </div>

          <button className={styles.submit} type="submit" disabled={carregando}>
            {carregando ? "Salvando..." : "Redefinir senha"}
          </button>
        </form>
      )}

      <div className={styles.footerLinks}>
        <a href="/login">Voltar ao login</a>
      </div>
    </>
  );
}
