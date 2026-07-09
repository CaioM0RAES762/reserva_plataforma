"use client";

import { useState, type FormEvent } from "react";
import styles from "../app/(app)/plataformas/page.module.css";

export interface PlataformaFormValues {
  codigo: string;
  nome: string;
  localizacao?: string;
  capacidade?: number;
  observacoes?: string;
  status?: "disponivel" | "manutencao" | "inativa";
}

export interface PlataformaEditavel {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  capacidade: number | null;
  observacoes: string | null;
  status: string;
}

interface PlataformaModalProps {
  plataforma: PlataformaEditavel | null;
  onClose: () => void;
  onSalvar: (valores: PlataformaFormValues) => Promise<void>;
}

export function PlataformaModal({ plataforma, onClose, onSalvar }: PlataformaModalProps) {
  const [codigo, setCodigo] = useState(plataforma?.codigo ?? "");
  const [nome, setNome] = useState(plataforma?.nome ?? "");
  const [localizacao, setLocalizacao] = useState(plataforma?.localizacao ?? "");
  const [capacidade, setCapacidade] = useState(plataforma?.capacidade?.toString() ?? "");
  const [observacoes, setObservacoes] = useState(plataforma?.observacoes ?? "");
  const [status, setStatus] = useState(
    plataforma && plataforma.status !== "reservada" ? plataforma.status : "disponivel"
  );
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);

    if (!codigo.trim() || !nome.trim()) {
      setErro("Preencha os campos obrigatórios.");
      return;
    }

    setSalvando(true);
    try {
      await onSalvar({
        codigo: codigo.trim(),
        nome: nome.trim(),
        localizacao: localizacao.trim() || undefined,
        capacidade: capacidade ? Number(capacidade) : undefined,
        observacoes: observacoes.trim() || undefined,
        status: plataforma ? (status as PlataformaFormValues["status"]) : undefined,
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar plataforma.");
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
          <h3>{plataforma ? "Editar Plataforma" : "Nova Plataforma"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && <div className={styles.error}>{erro}</div>}
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label htmlFor="pf-codigo">Código *</label>
                <input
                  id="pf-codigo"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="Ex: PLT-001"
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-nome">Nome *</label>
                <input id="pf-nome" value={nome} onChange={(e) => setNome(e.target.value)} required />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-localizacao">Localização</label>
                <input
                  id="pf-localizacao"
                  value={localizacao}
                  onChange={(e) => setLocalizacao(e.target.value)}
                  placeholder="Ex: Galpão A, Piso 2"
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-capacidade">Capacidade (kg)</label>
                <input
                  id="pf-capacidade"
                  type="number"
                  min="0"
                  value={capacidade}
                  onChange={(e) => setCapacidade(e.target.value)}
                />
              </div>
              {plataforma && (
                <div className={styles.formGroup}>
                  <label htmlFor="pf-status">Status</label>
                  <select id="pf-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="disponivel">Disponível</option>
                    <option value="manutencao">Em Manutenção</option>
                    <option value="inativa">Inativa</option>
                  </select>
                </div>
              )}
              <div className={`${styles.formGroup} ${styles.formGroupFull}`}>
                <label htmlFor="pf-observacoes">Observações</label>
                <textarea
                  id="pf-observacoes"
                  rows={2}
                  value={observacoes}
                  onChange={(e) => setObservacoes(e.target.value)}
                  placeholder="Informações adicionais..."
                />
              </div>
            </div>
          </div>
          <div className={styles.modalFooter}>
            <button type="button" className={styles.btnGhost} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={salvando}>
              {salvando ? "Salvando..." : plataforma ? "Salvar Alterações" : "Salvar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
