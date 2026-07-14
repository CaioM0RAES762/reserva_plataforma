"use client";

import { useState, type FormEvent } from "react";
import styles from "./Admin.module.css";

export interface SetorFormValues {
  nome: string;
  corHex: string;
}

export interface SetorEditavel {
  id: string;
  nome: string;
  corHex: string;
  ativo: boolean;
}

interface SetorModalProps {
  setor: SetorEditavel | null;
  onClose: () => void;
  onSalvar: (valores: SetorFormValues) => Promise<void>;
}

export function SetorModal({ setor, onClose, onSalvar }: SetorModalProps) {
  const [nome, setNome] = useState(setor?.nome ?? "");
  const [corHex, setCorHex] = useState(setor?.corHex ?? "#2563EB");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);

    if (!nome.trim()) {
      setErro("Informe o nome do setor.");
      return;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(corHex)) {
      setErro("Informe uma cor hexadecimal válida (ex.: #2563EB).");
      return;
    }

    setSalvando(true);
    try {
      await onSalvar({ nome: nome.trim(), corHex });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar setor.");
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
          <h3>{setor ? "Editar Setor" : "Novo Setor"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && <div className={styles.error}>{erro}</div>}
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label htmlFor="st-nome">Nome *</label>
                <input id="st-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="st-cor">Cor de identificação *</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    id="st-cor"
                    type="color"
                    value={corHex}
                    onChange={(e) => setCorHex(e.target.value)}
                    style={{ width: 44, height: 36, padding: 2 }}
                  />
                  <input
                    value={corHex}
                    onChange={(e) => setCorHex(e.target.value)}
                    placeholder="#2563EB"
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnGhost} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={salvando}>
              {salvando ? "Salvando..." : setor ? "Salvar Alterações" : "Salvar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
