"use client";

import { useState, type FormEvent } from "react";
import { apenasDigitosTelefone, MENSAGEM_TELEFONE_INVALIDO, SENHA_INICIAL_PADRAO, telefoneValido } from "@plataformares/shared";
import styles from "./Admin.module.css";
import { useModalAcessivel } from "../lib/useModalAcessivel";

type Perfil = "admin" | "gestor_setor" | "colaborador";

export interface SetorOpcao {
  id: string;
  nome: string;
}

export interface UsuarioFormValues {
  nome: string;
  email: string;
  telefone: string;
  perfil: Perfil;
  setorId: string | null;
}

export interface UsuarioEditavel {
  id: string;
  nome: string;
  email: string;
  telefone: string | null;
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
  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "usuario-modal");
  const [nome, setNome] = useState(usuario?.nome ?? "");
  const [email, setEmail] = useState(usuario?.email ?? "");
  const [telefone, setTelefone] = useState(usuario?.telefone ?? "");
  const [perfil, setPerfil] = useState<Perfil>(usuario?.perfil ?? "colaborador");
  const [setorId, setSetorId] = useState(usuario?.setorId ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Telefone é obrigatório na criação; na edição, só valida se algo foi digitado (contas
  // anteriores à migration 0021 podem não ter o dado, e editar nome/e-mail não deveria
  // travar por causa disso).
  const telefoneObrigatorio = !usuario;

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
    if (telefoneObrigatorio && !telefone.trim()) {
      setErro("Informe o número de contato.");
      return;
    }
    if (telefone.trim() && !telefoneValido(telefone)) {
      setErro(MENSAGEM_TELEFONE_INVALIDO);
      return;
    }

    setSalvando(true);
    try {
      await onSalvar({
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        // Normalizado (só dígitos) — a máscara é só apresentação.
        telefone: apenasDigitosTelefone(telefone),
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
      onClick={aoClicarNoOverlay}
    >
      <div className={styles.modal} ref={refDialogo} {...propsDialogo}>
        <div className={styles.modalHeader}>
          <h3 id={idTitulo}>{usuario ? "Editar Usuário" : "Novo Usuário"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <form className={styles.modalForm} onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && (
              <div className={styles.error} role="alert">
                {erro}
              </div>
            )}
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
                <label htmlFor="us-telefone">Número de contato{telefoneObrigatorio ? " *" : ""}</label>
                <input
                  id="us-telefone"
                  type="tel"
                  inputMode="tel"
                  value={telefone}
                  onChange={(e) => setTelefone(e.target.value)}
                  placeholder="(31) 99999-9999"
                  required={telefoneObrigatorio}
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
                  <div className={styles.senhaInicialBox}>
                    <span className={styles.senhaInicialLabel}>Senha inicial</span>
                    <span className={styles.senhaInicialValor}>{SENHA_INICIAL_PADRAO}</span>
                  </div>
                  <span className={styles.formHint}>
                    O usuário poderá entrar com essa senha e será obrigado a trocá-la no primeiro acesso.
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
