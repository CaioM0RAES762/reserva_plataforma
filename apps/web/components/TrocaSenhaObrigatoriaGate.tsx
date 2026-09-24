"use client";

import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import styles from "./TrocaSenhaObrigatoriaGate.module.css";
import { TrocarSenhaForm } from "./TrocarSenhaForm";
import { apiFetch } from "../lib/api";

/**
 * Bloqueia o restante da aplicação até a troca da senha inicial (Admin → Novo Usuário →
 * senha provisória, ver migration 0021). O layout server-side (`app/(app)/layout.tsx`)
 * decide SE este gate aparece; aqui só cuida da troca em si e de liberar o acesso depois.
 *
 * "Senha atual" no formulário é literalmente a senha inicial que o Admin informou — o
 * usuário já a conhece, não é um passo extra.
 */
export function TrocaSenhaObrigatoriaGate() {
  const router = useRouter();

  async function handleSair() {
    try {
      await apiFetch("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // Mesmo se a chamada falhar, segue para o login — o cookie pode já ter expirado.
    } finally {
      router.replace("/login");
    }
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <span className={styles.icone} aria-hidden="true">
          <ShieldAlert size={22} strokeWidth={1.75} />
        </span>
        <h1 className={styles.titulo}>Defina sua senha</h1>
        <p className={styles.subtitulo}>
          Sua conta foi criada com uma senha provisória. Defina uma senha só sua para continuar.
        </p>

        {/* router.refresh() reexecuta o layout server-side, que busca /conta de novo — a
            troca já zerou senha_provisoria no banco, então o gate não aparece mais. */}
        <TrocarSenhaForm onSucesso={() => router.refresh()} />

        <button type="button" className={styles.sair} onClick={handleSair}>
          Sair
        </button>
      </div>
    </div>
  );
}
