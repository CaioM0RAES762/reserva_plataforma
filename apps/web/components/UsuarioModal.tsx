"use client";

import { useState, type FormEvent } from "react";
import styles from "./Admin.module.css";

type Perfil = "admin" | "gestor_setor" | "colaborador";

export interface SetorOpcao {
  id: string;
  nome: string;
}

export interface UsuarioFormValues {
  nome: string;
  email: string;
  perfil: Perfil;
  setorId: string | null;
}

export interface UsuarioEditavel {
  id: string;
  nome: string;
  email: string;
  perfil: Perfil;
  setorId: string | null;
}

interface UsuarioModalProps {
  usuario: UsuarioEditavel | null;
  setores: SetorOpcao[];
  onClose: () => void;
  onSalvar: (valores: UsuarioFormValues) => Promise<void>;
}

const PERFIL_LABEL: Record<Perfil, string> = {
  admin: "Admin",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

export function UsuarioModal({ usuario, setores, onClose, onSalvar }: UsuarioModalProps) {
  const [nome, setNome] = useState(usuario?.nome ?? "");
  const [email, setEmail] = useState(usuario?.email ?? "");
  const [perfil, setPerfil] = useState<Perfil>(usuario?.perfil ?? "colaborador");
  const [setorId, setSetorId] = useState(usuario?.setorId ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);

    if (!nome.trim() || !email.trim()) {
      setErro("Preencha os campos obrigatórios.");
      return;
    }
    if (perfil !== "admin" && !setorId) {
      setErro("Selecione um setor para os perfis Gestor de Setor e Colaborador.");
      return;
    }

    setSalvando(true);
    try {
      await onSalvar({
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        perfil,
        setorId: perfil === "admin" ? null : setorId,
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar usuário.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div
      className={styles.modalOverlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h3>{usuario ? "Editar Usuário" : "Novo Usuário"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && <div className={styles.error}>{erro}</div>}
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label htmlFor="us-nome">Nome *</label>
                <input id="us-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="us-email">E-mail *</label>
                <input
                  id="us-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="usuario@metalsider.com.br"
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="us-perfil">Perfil *</label>
                <select id="us-perfil" value={perfil} onChange={(e) => setPerfil(e.target.value as Perfil)}>
                  {(Object.keys(PERFIL_LABEL) as Perfil[]).map((p) => (
                    <option key={p} value={p}>
                      {PERFIL_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
              {perfil !== "admin" && (
                <div className={styles.formGroup}>
                  <label htmlFor="us-setor">Setor *</label>
                  <select id="us-setor" value={setorId} onChange={(e) => setSetorId(e.target.value)}>
                    <option value="">Selecione...</option>
                    {setores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nome}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!usuario && (
                <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                  <span className={styles.formHint}>
                    Um código de ativação será enviado por e-mail para o novo usuário definir a senha.
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnGhost} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={salvando}>
              {salvando ? "Salvando..." : usuario ? "Salvar Alterações" : "Salvar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
