"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "../app/(app)/plataformas/page.module.css";
import { apiFetch } from "../lib/api";

interface PainelToken {
  id: string;
  nome: string;
  setorId: string | null;
  setorNome: string | null;
  ativo: boolean;
  criadoPorNome: string;
  criadoEm: string;
  ultimoUsoEm: string | null;
}

interface PainelTokenCriado extends PainelToken {
  token: string;
}

interface SetorOpcao {
  id: string;
  nome: string;
}

const WEB_URL = typeof window !== "undefined" ? window.location.origin : "";

function formatarData(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// RF-TV-03: Admin gera/gerencia tokens de dispositivo do Painel TV, cada um escopado a
// um setor (galpão) ou a todos os setores. O token em texto puro só é exibido uma vez,
// logo após a criação (mesmo padrão de segredo de API key).
export function PainelTokensClient() {
  const [tokens, setTokens] = useState<PainelToken[]>([]);
  const [setores, setSetores] = useState<SetorOpcao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [modalAberto, setModalAberto] = useState(false);

  const [nome, setNome] = useState("");
  const [setorId, setSetorId] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [tokenCriado, setTokenCriado] = useState<PainelTokenCriado | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const [dadosTokens, dadosSetores] = await Promise.all([
        apiFetch<PainelToken[]>("/api/v1/painel/tokens"),
        apiFetch<SetorOpcao[]>("/api/v1/setores"),
      ]);
      setTokens(dadosTokens);
      setSetores(dadosSetores);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar tokens do Painel TV.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function abrirModal() {
    setNome("");
    setSetorId("");
    setErroForm(null);
    setTokenCriado(null);
    setModalAberto(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!nome.trim()) {
      setErroForm("Informe um nome para identificar o dispositivo.");
      return;
    }
    setErroForm(null);
    setSalvando(true);
    try {
      const resposta = await apiFetch<PainelTokenCriado>("/api/v1/painel/tokens", {
        method: "POST",
        body: JSON.stringify({ nome: nome.trim(), setorId: setorId || null }),
      });
      setTokenCriado(resposta);
      await carregar();
    } catch (err) {
      setErroForm(err instanceof Error ? err.message : "Erro ao gerar token.");
    } finally {
      setSalvando(false);
    }
  }

  async function handleRevogar(token: PainelToken) {
    if (!confirm(`Revogar o token "${token.nome}"? O dispositivo perderá acesso imediatamente.`)) return;
    setErro(null);
    try {
      await apiFetch(`/api/v1/painel/tokens/${token.id}`, { method: "DELETE" });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao revogar token.");
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Painel TV</h1>
          <p>Tokens de dispositivo para exibição no chão de fábrica (RF-TV-03)</p>
        </div>
        <button className={styles.btnPrimary} onClick={abrirModal}>
          Novo Token
        </button>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Escopo</th>
              <th>Status</th>
              <th>Último uso</th>
              <th>Criado por</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr>
                <td colSpan={6} className={styles.empty}>Carregando...</td>
              </tr>
            ) : tokens.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.empty}>Nenhum token de Painel TV cadastrado.</td>
              </tr>
            ) : (
              tokens.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.nome}</strong></td>
                  <td>{t.setorNome ?? "Todos os setores"}</td>
                  <td>{t.ativo ? "Ativo" : "Revogado"}</td>
                  <td>{formatarData(t.ultimoUsoEm)}</td>
                  <td>{t.criadoPorNome}</td>
                  <td>
                    {t.ativo ? (
                      <button className={styles.btnGhost} onClick={() => handleRevogar(t)}>
                        Revogar
                      </button>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>Revogado</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalAberto && (
        <div
          className={styles.modalOverlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) setModalAberto(false);
          }}
        >
          <div className={styles.modal}>
            <div className={styles.modalHeader}>
              <h3>{tokenCriado ? "Token gerado" : "Novo Token de Painel TV"}</h3>
              <button type="button" className={styles.modalClose} onClick={() => setModalAberto(false)}>
                ✕
              </button>
            </div>

            {tokenCriado ? (
              <div className={styles.modalBody}>
                <div className={styles.error} style={{ background: "var(--green-light)", color: "var(--green)", borderColor: "var(--green)" }}>
                  <strong>Copie o token agora — ele não será exibido novamente.</strong>
                </div>
                <div className={styles.formGroup} style={{ marginTop: 12 }}>
                  <label htmlFor="pt-token-valor">Token</label>
                  <input
                    id="pt-token-valor"
                    readOnly
                    value={tokenCriado.token}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <div className={styles.formGroup} style={{ marginTop: 12 }}>
                  <label htmlFor="pt-url-painel">URL do Painel</label>
                  <input
                    id="pt-url-painel"
                    readOnly
                    value={`${WEB_URL}/painel?token=${tokenCriado.token}`}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className={styles.modalBody}>
                  {erroForm && <div className={styles.error}>{erroForm}</div>}
                  <div className={styles.formGrid}>
                    <div className={styles.formGroup} style={{ gridColumn: "1 / -1" }}>
                      <label htmlFor="pt-nome">Nome do dispositivo *</label>
                      <input
                        id="pt-nome"
                        value={nome}
                        onChange={(e) => setNome(e.target.value)}
                        placeholder="Ex.: TV Galpão TI"
                        required
                      />
                    </div>
                    <div className={styles.formGroup} style={{ gridColumn: "1 / -1" }}>
                      <label htmlFor="pt-setor">Setor visível</label>
                      <select id="pt-setor" value={setorId} onChange={(e) => setSetorId(e.target.value)}>
                        <option value="">Todos os setores</option>
                        {setores.map((s) => (
                          <option key={s.id} value={s.id}>{s.nome}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                <div className={styles.modalFooter}>
                  <button type="button" className={styles.btnGhost} onClick={() => setModalAberto(false)}>
                    Cancelar
                  </button>
                  <button type="submit" className={styles.btnPrimary} disabled={salvando}>
                    {salvando ? "Gerando..." : "Gerar Token"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
