"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import styles from "../../../components/auth/AuthForm.module.css";
import { PasswordField, TextField } from "../../../components/auth/AuthFields";
import { ApiRequestError, apiFetch, mensagemDeErro } from "../../../lib/api";

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
        body: JSON.stringify({ email: email.trim(), senha }),
      });
      // `replace` em vez de `push`: voltar no navegador depois de entrar levava de volta
      // ao formulário de login já autenticado. `refresh` descarta o cache do App Router
      // para o layout autenticado buscar os dados da conta recém-logada.
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      // O backend responde 403 com motivos distintos (conta desativada / conta não
      // ativada) — mensagens que ficavam iguais a "credenciais inválidas" aos olhos do
      // usuário. Aqui elas são complementadas com o próximo passo concreto.
      if (err instanceof ApiRequestError && err.status === 403 && err.message.includes("não ativada")) {
        setErro(`${err.message} Use "Ativar conta" abaixo para definir sua senha.`);
      } else {
        setErro(mensagemDeErro(err, "Erro ao entrar."));
      }
      setCarregando(false);
      return;
    }
    // Sem setCarregando(false) no caminho de sucesso: a navegação já está a caminho e
    // reabilitar o botão permitiria um segundo envio durante a transição.
  }

  return (
    <>
      <div className={styles.header}>
        <h1 className={styles.title}>Entrar na plataforma</h1>
        <p className={styles.subtitle}>
          Use seu e-mail corporativo MetalSider para acessar o quadro de reservas do seu setor.
        </p>
      </div>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
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
          // Sem autoComplete, o gerenciador de senhas do navegador não oferecia
          // preenchimento nem salvava a credencial após o login.
          autoComplete="username"
          autoFocus
          placeholder="nome@metalsider.com.br"
          value={email}
          onChange={setEmail}
        />

        <PasswordField
          id="senha"
          label="Senha"
          value={senha}
          onChange={setSenha}
          autoComplete="current-password"
        />

        <div className={styles.actions}>
          <button className={styles.submit} type="submit" disabled={carregando}>
            {carregando && <span className={styles.spinner} aria-hidden="true" />}
            {carregando ? "Entrando..." : "Entrar"}
          </button>
          {/* <a> puro forçava recarga completa do app a cada clique; Link mantém a
              navegação client-side do App Router. */}
          <Link href="/recuperar-senha" className={styles.inlineLink}>
            Esqueci minha senha
          </Link>
        </div>
      </form>

      <p className={styles.formFooter}>
        Primeiro acesso?{" "}
        <Link href="/ativar-conta" className={styles.emberLink}>
          Criar conta
        </Link>{" "}
        com seu e-mail corporativo.
      </p>
    </>
  );
}
