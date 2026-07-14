"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { apiFetch } from "../lib/api";
import { UsuarioModal, type SetorOpcao, type UsuarioEditavel, type UsuarioFormValues } from "./UsuarioModal";

type Perfil = "admin" | "gestor_setor" | "colaborador";

interface Usuario {
  id: string;
  nome: string;
  email: string;
  perfil: Perfil;
  setorId: string | null;
  setorNome: string | null;
  ativo: boolean;
  emailVerificado: boolean;
}

const PERFIL_LABEL: Record<Perfil, string> = {
  admin: "Admin",
  gestor_setor: "Gestor de Setor",
  colaborador: "Colaborador",
};

export function UsuariosClient() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [setores, setSetores] = useState<SetorOpcao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [setorFiltro, setSetorFiltro] = useState("");
  const [perfilFiltro, setPerfilFiltro] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<UsuarioEditavel | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (busca) params.set("q", busca);
      if (setorFiltro) params.set("setor", setorFiltro);
      if (perfilFiltro) params.set("perfil", perfilFiltro);
      if (statusFiltro) params.set("status", statusFiltro);
      const query = params.toString();
      const dados = await apiFetch<Usuario[]>(`/api/v1/usuarios${query ? `?${query}` : ""}`);
      setUsuarios(dados);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar usuários.");
    } finally {
      setCarregando(false);
    }
  }, [busca, setorFiltro, perfilFiltro, statusFiltro]);

  useEffect(() => {
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetores)
      .catch(() => setSetores([]));
  }, []);

  useEffect(() => {
    const timer = setTimeout(carregar, 250);
    return () => clearTimeout(timer);
  }, [carregar]);

  async function handleSalvar(valores: UsuarioFormValues) {
    if (editando) {
      await apiFetch(`/api/v1/usuarios/${editando.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nome: valores.nome, email: valores.email, setorId: valores.setorId }),
      });
      if (valores.perfil !== editando.perfil) {
        await apiFetch(`/api/v1/usuarios/${editando.id}/perfil`, {
          method: "PATCH",
          body: JSON.stringify({ perfil: valores.perfil, setorId: valores.setorId }),
        });
      }
    } else {
      await apiFetch("/api/v1/usuarios", {
        method: "POST",
        body: JSON.stringify(valores),
      });
    }
    setModalAberto(false);
    setEditando(null);
    await carregar();
  }

  async function handleToggleStatus(usuario: Usuario) {
    setErro(null);
    setMensagem(null);
    try {
      await apiFetch(`/api/v1/usuarios/${usuario.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ ativo: !usuario.ativo }),
      });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status do usuário.");
    }
  }

  async function handleReenviarCodigo(usuario: Usuario) {
    setErro(null);
    setMensagem(null);
    try {
      const resposta = await apiFetch<{ mensagem: string; tipo: string }>(
        `/api/v1/usuarios/${usuario.id}/reenviar-codigo`,
        { method: "POST" }
      );
      setMensagem(
        `Código reenviado para ${usuario.email} (${resposta.tipo === "ativacao_conta" ? "ativação de conta" : "redefinição de senha"}).`
      );
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao reenviar código.");
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Usuários</h1>
          <p>Gerencie contas, perfis e vínculos de setor (RF-USR-01..05)</p>
        </div>
        <button
          className={styles.btnPrimary}
          onClick={() => {
            setEditando(null);
            setModalAberto(true);
          }}
        >
          Novo Usuário
        </button>
      </div>

      <div className={styles.filterBar}>
        <input
          type="text"
          placeholder="Buscar por nome ou e-mail..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
        />
        <select value={setorFiltro} onChange={(e) => setSetorFiltro(e.target.value)}>
          <option value="">Todos os setores</option>
          {setores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nome}
            </option>
          ))}
        </select>
        <select value={perfilFiltro} onChange={(e) => setPerfilFiltro(e.target.value)}>
          <option value="">Todos os perfis</option>
          <option value="admin">Admin</option>
          <option value="gestor_setor">Gestor de Setor</option>
          <option value="colaborador">Colaborador</option>
        </select>
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="ativo">Ativo</option>
          <option value="inativo">Inativo</option>
        </select>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}
      {mensagem && <div className={styles.success}>{mensagem}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Perfil</th>
              <th>Setor</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : usuarios.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  Nenhum usuário encontrado.
                </td>
              </tr>
            ) : (
              usuarios.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.nome}</strong>
                  </td>
                  <td>{u.email}</td>
                  <td>{PERFIL_LABEL[u.perfil]}</td>
                  <td>{u.setorNome ?? "—"}</td>
                  <td>
                    <span className={`${styles.badge} ${u.ativo ? styles.badgeAtivo : styles.badgeInativo}`}>
                      {u.ativo ? "Ativo" : "Inativo"}
                    </span>
                    {!u.emailVerificado && (
                      <span className={styles.badge} style={{ marginLeft: 6, background: "rgba(217,119,6,0.12)", color: "#D97706" }}>
                        Não ativado
                      </span>
                    )}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        className={styles.btnIcon}
                        onClick={() => {
                          setEditando({ id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, setorId: u.setorId });
                          setModalAberto(true);
                        }}
                      >
                        Editar
                      </button>
                      <button className={styles.btnIcon} onClick={() => handleReenviarCodigo(u)}>
                        Reenviar Código
                      </button>
                      <button className={styles.btnIconDanger} onClick={() => handleToggleStatus(u)}>
                        {u.ativo ? "Desativar" : "Ativar"}
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
        <UsuarioModal
          usuario={editando}
          setores={setores}
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
