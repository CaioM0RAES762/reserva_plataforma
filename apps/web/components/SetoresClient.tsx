"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { apiFetch } from "../lib/api";
import { SetorModal, type SetorEditavel, type SetorFormValues } from "./SetorModal";

interface Setor {
  id: string;
  nome: string;
  corHex: string;
  ativo: boolean;
}

export function SetoresClient() {
  const [setores, setSetores] = useState<Setor[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<SetorEditavel | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await apiFetch<Setor[]>("/api/v1/setores/admin");
      setSetores(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar setores.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleSalvar(valores: SetorFormValues) {
    if (editando) {
      await apiFetch(`/api/v1/setores/${editando.id}`, {
        method: "PATCH",
        body: JSON.stringify(valores),
      });
    } else {
      await apiFetch("/api/v1/setores", {
        method: "POST",
        body: JSON.stringify(valores),
      });
    }
    setModalAberto(false);
    setEditando(null);
    await carregar();
  }

  async function handleToggleStatus(setor: Setor) {
    setErro(null);
    try {
      await apiFetch(`/api/v1/setores/${setor.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ ativo: !setor.ativo }),
      });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status do setor.");
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Setores</h1>
          <p>Gerencie os setores da empresa (RF-SET-01/02)</p>
        </div>
        <button
          className={styles.btnPrimary}
          onClick={() => {
            setEditando(null);
            setModalAberto(true);
          }}
        >
          Novo Setor
        </button>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Setor</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={3} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : setores.length === 0 ? (
              <tr>
                <td colSpan={3} className={styles.empty}>
                  Nenhum setor cadastrado.
                </td>
              </tr>
            ) : (
              setores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className={styles.setorSwatch}>
                      <span style={{ background: s.corHex }} />
                      <strong>{s.nome}</strong>
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.badge} ${s.ativo ? styles.badgeAtivo : styles.badgeInativo}`}>
                      {s.ativo ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        className={styles.btnIcon}
                        onClick={() => {
                          setEditando(s);
                          setModalAberto(true);
                        }}
                      >
                        Editar
                      </button>
                      <button className={styles.btnIconDanger} onClick={() => handleToggleStatus(s)}>
                        {s.ativo ? "Desativar" : "Ativar"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalAberto && (
        <SetorModal
          setor={editando}
          onClose={() => {
            setModalAberto(false);
            setEditando(null);
          }}
          onSalvar={handleSalvar}
        />
      )}
    </section>
  );
}
