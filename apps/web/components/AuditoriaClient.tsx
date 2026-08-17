"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { apiDownload, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { Paginacao } from "./Paginacao";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335";
const POR_PAGINA = 50;

interface Auditoria {
  id: string;
  usuarioId: string | null;
  usuarioNome: string | null;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  // Estava presente na resposta da API desde S12, mas nenhuma coluna da tabela o exibia —
  // justamente o campo que diz O QUE mudou (status anterior/novo, motivo, chaves de
  // configuração alteradas). Sem ele, a tela só respondia "quem" e "quando".
  detalhes: unknown;
  criadoEm: string;
}

function formatarDetalhes(detalhes: unknown): string {
  if (detalhes === null || detalhes === undefined) return "—";
  if (typeof detalhes === "string") return detalhes;
  const entradas = Object.entries(detalhes as Record<string, unknown>);
  if (entradas.length === 0) return "—";
  return entradas.map(([chave, valor]) => `${chave}: ${String(valor)}`).join(" · ");
}

export function AuditoriaClient() {
  const [registros, setRegistros] = useState<Auditoria[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [acao, setAcao] = useState("");
  const [entidade, setEntidade] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exportando, setExportando] = useState(false);

  const acaoComAtraso = useDebounce(acao);

  const montarQuery = useCallback(
    (comPaginacao: boolean) => {
      const params = new URLSearchParams();
      if (acaoComAtraso) params.set("acao", acaoComAtraso);
      if (entidade) params.set("entidade", entidade);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (comPaginacao) {
        params.set("limit", String(POR_PAGINA));
        params.set("offset", String(pagina * POR_PAGINA));
      }
      return params.toString();
    },
    [acaoComAtraso, entidade, dateFrom, dateTo, pagina]
  );

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resposta = await fetch(`${API_URL}/api/v1/auditoria?${montarQuery(true)}`, {
        credentials: "include",
      });
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error((corpo as { erro?: string }).erro ?? "Erro ao carregar auditoria.");
      }
      setRegistros((await resposta.json()) as Auditoria[]);
      // A rota antes devolvia um TOP 500 fixo e a tela não tinha como indicar que havia
      // mais registros — agora o total real vem no header e alimenta a paginação.
      setTotal(Number(resposta.headers.get("X-Total-Count") ?? 0));
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar auditoria."));
    } finally {
      setCarregando(false);
    }
  }, [montarQuery]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => {
    setPagina(0);
  }, [acaoComAtraso, entidade, dateFrom, dateTo]);

  async function handleExportar() {
    setErro(null);
    setExportando(true);
    try {
      // Exportação sempre com o resultado completo do filtro, sem a janela de paginação.
      await apiDownload(
        `/api/v1/auditoria/export?${montarQuery(false)}`,
        `auditoria_${new Date().toISOString().slice(0, 10)}.csv`
      );
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao exportar auditoria."));
    } finally {
      setExportando(false);
    }
  }

  const periodoInvalido = Boolean(dateFrom && dateTo && dateTo < dateFrom);

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Auditoria</h1>
          <p>Consulte e exporte o histórico de ações sensíveis do sistema (RF-AUD-01/02)</p>
        </div>
        <button className={styles.btnPrimary} onClick={handleExportar} disabled={exportando}>
          {exportando ? "Exportando..." : "Exportar CSV"}
        </button>
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          placeholder="Filtrar por ação (ex.: criar_reserva)"
          value={acao}
          onChange={(e) => setAcao(e.target.value)}
          className={styles.search}
          aria-label="Filtrar por ação"
        />
        <select value={entidade} onChange={(e) => setEntidade(e.target.value)} aria-label="Filtrar por entidade">
          <option value="">Todas as entidades</option>
          <option value="Reserva">Reserva</option>
          <option value="Plataforma">Plataforma</option>
          <option value="Usuario">Usuário</option>
          <option value="Setor">Setor</option>
          <option value="BloqueioAgenda">Bloqueio de Agenda</option>
          <option value="Checklist">Checklist</option>
          <option value="Comentario">Comentário</option>
          <option value="Ocorrencia">Ocorrência</option>
          <option value="Anexo">Anexo</option>
          <option value="ConfiguracaoSistema">Configuração do Sistema</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          aria-label="Data inicial"
          max={dateTo || undefined}
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          aria-label="Data final"
          min={dateFrom || undefined}
        />
      </div>

      {periodoInvalido && (
        <div className={styles.error} role="alert">
          A data final é anterior à data inicial — ajuste o período para ver resultados.
        </div>
      )}
      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Data/Hora</th>
              <th scope="col">Usuário</th>
              <th scope="col">Ação</th>
              <th scope="col">Entidade</th>
              <th scope="col">Detalhes</th>
            </tr>
          </thead>
          <tbody aria-busy={carregando}>
            {carregando && registros.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  Carregando...
                </td>
              </tr>
            ) : registros.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  Nenhum registro encontrado para os filtros aplicados.
                </td>
              </tr>
            ) : (
              registros.map((r) => {
                const detalhesTexto = formatarDetalhes(r.detalhes);
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(r.criadoEm).toLocaleString("pt-BR")}</td>
                    <td>{r.usuarioNome ?? "Sistema"}</td>
                    <td>
                      <strong>{r.acao}</strong>
                    </td>
                    <td>
                      {r.entidade}
                      {r.entidadeId && (
                        <span
                          style={{ display: "block", fontSize: "var(--text-meta)", color: "var(--ink-muted)" }}
                          title={r.entidadeId}
                        >
                          {r.entidadeId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td style={{ maxWidth: 320, fontSize: "var(--text-secondary)" }} title={detalhesTexto}>
                      {detalhesTexto.length > 90 ? `${detalhesTexto.slice(0, 90)}…` : detalhesTexto}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Paginacao
        total={total}
        pagina={pagina}
        porPagina={POR_PAGINA}
        carregando={carregando}
        onMudarPagina={setPagina}
        rotuloItens="registro(s) de auditoria"
      />
    </section>
  );
}
