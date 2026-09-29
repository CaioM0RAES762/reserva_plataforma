"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Check } from "lucide-react";
import styles from "../../../components/auth/AuthForm.module.css";
import { AuthStepper } from "../../../components/auth/AuthStepper";
import { CodeField, PasswordField, TextField } from "../../../components/auth/AuthFields";
import { PasswordStrength, senhaAtendeRequisitos } from "../../../components/auth/PasswordStrength";
import { useResendCooldown } from "../../../components/auth/useResendCooldown";
import { mascararEmail } from "../../../components/auth/mascararEmail";
import { DicaCaixaOutros } from "../../../components/auth/DicaCaixaOutros";
import { apiFetch, mensagemDeErro } from "../../../lib/api";

const ETAPAS = ["E-mail", "Novo acesso", "Concluído"];

type Etapa = 0 | 1 | 2;

export default function RecuperarSenhaPage() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<Etapa>(0);
  const [email, setEmail] = useState("");
  const [codigo, setCodigo] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmarSenha, setConfirmarSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [erroCodigo, setErroCodigo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  // Ver comentário equivalente em app/(auth)/ativar-conta/page.tsx: bloqueia clique duplo
  // no "Reenviar código" mesmo antes do cooldown pós-sucesso começar a contar.
  const [reenviando, setReenviando] = useState(false);
  const cooldown = useResendCooldown();

  async function solicitarCodigo(): Promise<void> {
    await apiFetch("/api/v1/auth/recuperar-senha", {
      method: "POST",
      body: JSON.stringify({ email: email.trim() }),
    });
  }

  async function handleSolicitar(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      await solicitarCodigo();
      cooldown.iniciar();
      setEtapa(1);
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível enviar o código. Tente novamente."));
    } finally {
      setCarregando(false);
    }
  }

  async function handleReenviar() {
    if (reenviando || cooldown.emCooldown) return;
    setErro(null);
    setAviso(null);
    setReenviando(true);
    try {
      await solicitarCodigo();
      cooldown.iniciar();
      setAviso("Código enviado para seu e-mail.");
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível enviar o código. Tente novamente."));
    } finally {
      setReenviando(false);
    }
  }

  async function handleConfirmar(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setErroCodigo(null);
    if (novaSenha !== confirmarSenha) {
      setErro("As senhas não coincidem.");
      return;
    }
    setCarregando(true);
    try {
      await apiFetch("/api/v1/auth/recuperar-senha/confirmar", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), codigo, novaSenha }),
      });
      setEtapa(2);
    } catch (err) {
      const mensagem = mensagemDeErro(err, "Não foi possível redefinir a senha.");
      if (/código/i.test(mensagem)) setErroCodigo(mensagem);
      else setErro(mensagem);
    } finally {
      setCarregando(false);
    }
  }

  if (etapa === 2) {
    return (
      <>
        <AuthStepper etapas={ETAPAS} etapaAtual={2} />
        <span className={styles.successIcon} aria-hidden="true">
          <Check size={22} strokeWidth={2.5} />
        </span>
        <div className={styles.header}>
          <h1 className={styles.title}>Senha atualizada</h1>
          <p className={styles.subtitle}>
            Sua nova senha foi definida. Você já pode acessar a plataforma.
          </p>
        </div>
        <div className={styles.successActions}>
          <button className={styles.submit} type="button" onClick={() => router.push("/login")}>
            Voltar para o login
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthStepper etapas={ETAPAS} etapaAtual={etapa} />

      {etapa === 0 && (
        <>
          <div className={styles.header}>
            <h1 className={styles.title}>Recuperar senha</h1>
            <p className={styles.subtitle}>
              Informe seu e-mail corporativo. Enviaremos um código de verificação válido por 15 minutos.
            </p>
          </div>

          <form className={styles.form} onSubmit={handleSolicitar} noValidate>
            {erro && (
              <div className={styles.alertErro} role="alert">
                <AlertCircle size={16} />
                <span>{erro}</span>
              </div>
            )}

            <TextField
              id="email"
              label="E-mail corporativo"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoFocus
              placeholder="nome@metalsider.com.br"
              value={email}
              onChange={setEmail}
            />

            <div className={styles.actions}>
              <button className={styles.submit} type="submit" disabled={carregando || !email.trim()}>
                {carregando && <span className={styles.spinner} aria-hidden="true" />}
                {carregando ? "Enviando código..." : "Enviar código"}
              </button>
              <Link href="/login" className={styles.inlineLink}>
                Voltar ao login
              </Link>
            </div>
          </form>
        </>
      )}

      {etapa === 1 && (
        <>
          <div className={styles.header}>
            <h1 className={styles.title}>Defina uma nova senha</h1>
            <p className={styles.subtitle}>
              Enviamos um código de 6 dígitos para{" "}
              <span className={styles.maskedEmail}>{mascararEmail(email)}</span>. Informe-o e crie sua
              nova senha de acesso.
            </p>
            <DicaCaixaOutros />
          </div>

          <form className={styles.form} onSubmit={handleConfirmar} noValidate>
            {erro && (
              <div className={styles.alertErro} role="alert">
                <AlertCircle size={16} />
                <span>{erro}</span>
              </div>
            )}
            {aviso && !erro && (
              <div className={styles.alertOk} role="status">
                <Check size={16} />
                <span>{aviso}</span>
              </div>
            )}

            <CodeField
              id="codigo"
              label="Código de verificação"
              value={codigo}
              onChange={(valor) => {
                setCodigo(valor);
                setErroCodigo(null);
              }}
              autoFocus
              erro={erroCodigo}
              hint="Válido por 15 minutos, uso único."
            />

            <div className={styles.pairGrid}>
              <PasswordField
                id="novaSenha"
                label="Nova senha"
                value={novaSenha}
                onChange={setNovaSenha}
                autoComplete="new-password"
              />
              <PasswordField
                id="confirmarSenha"
                label="Confirmar senha"
                value={confirmarSenha}
                onChange={setConfirmarSenha}
                autoComplete="new-password"
              />
            </div>

            <PasswordStrength senha={novaSenha} />

            <div className={styles.actions}>
              <button
                className={styles.submit}
                type="submit"
                disabled={
                  carregando ||
                  codigo.length !== 6 ||
                  !senhaAtendeRequisitos(novaSenha) ||
                  novaSenha !== confirmarSenha
                }
              >
                {carregando && <span className={styles.spinner} aria-hidden="true" />}
                {carregando ? "Salvando..." : "Redefinir senha"}
              </button>
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleReenviar}
                disabled={cooldown.emCooldown || reenviando}
              >
                {cooldown.emCooldown
                  ? `Reenviar código em ${cooldown.segundosRestantes}s`
                  : reenviando
                    ? "Enviando..."
                    : "Reenviar código"}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
