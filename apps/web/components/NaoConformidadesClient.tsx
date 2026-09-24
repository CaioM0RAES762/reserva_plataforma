"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";
import { STATUS_NAO_CONFORMIDADE, type NaoConformidadePublica } from "@plataformares/shared";
import styles from "../app/(app)/nao-conformidades/page.module.css";
import { CampoFiltro, FiltrosAvancados } from "./FiltrosAvancados";
import { Paginacao } from "./Paginacao";
import { NaoConformidadeDetalheDrawer } from "./NaoConformidadeDetalheDrawer";
import { apiFetch, mensagemDeErro } from "../lib/api";

const POR_PAGINA = 30;

const STATUS_LABELS: Record<string, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  resolvida: "Resolvida",
};

interface SetorOpcao {
  id: string;
  nome: string;
}
interface PlataformaOpcao {
  id: string;
  nome: string;
}
interface UsuarioOpcao {
  id: string;
  nome: string;
}

function formatarCarimbo(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

export interface NaoConformidadesClientProps {
  perfil: "admin" | "gestor_setor" | "colaborador";
  setorId: string | null;
}

/**
 * Não Conformidades — acompanhamento das ocorrências registradas.
 *
 * A origem do dado continua sendo o comentário marcado como não conformidade na reserva
 * (ComentariosReserva): esta tela só agrega e permite tratar o status entre reservas. Nada
 * aqui duplica descrição/imagem/reserva — "Ver reserva" (no drawer) leva à origem.
 */
export function NaoConformidadesClient({ perfil, setorId }: NaoConformidadesClientProps) {
  const [itens, setItens] = useState<NaoConformidadePublica[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [selecionada, setSelecionada] = useState<NaoConformidadePublica | null>(null);

  const [texto, setTexto] = useState("");
  const [status, setStatus] = useState("");
  const [setorFiltro, setSetorFiltro] = useState("");
  const [plataformaFiltro, setPlataformaFiltro] = useState("");
  const [responsavelFiltro, setResponsavelFiltro] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [setoresOpcoes, setSetoresOpcoes] = useState<SetorOpcao[]>([]);
  const [plataformasOpcoes, setPlataformasOpcoes] = useState<PlataformaOpcao[]>([]);
  const [usuariosOpcoes, setUsuariosOpcoes] = useState<UsuarioOpcao[]>([]);

  const podeTratarStatus = perfil === "admin" || perfil === "gestor_setor";

  useEffect(() => {
    if (perfil !== "admin") return;
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetoresOpcoes)
      .catch(() => setSetoresOpcoes([]));
  }, [perfil]);

  useEffect(() => {
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((lista) => setPlataformasOpcoes(lista.map((p) => ({ id: p.id, nome: p.nome }))))
      .catch(() => setPlataformasOpcoes([]));
  }, []);

  useEffect(() => {
    apiFetch<UsuarioOpcao[]>("/api/v1/usuarios")
      .then((lista) => setUsuariosOpcoes(lista.map((u) => ({ id: u.id, nome: u.nome }))))
      .catch(() => setUsuariosOpcoes([]));
  }, []);

  const montarQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (texto) params.set("texto", texto);
    if (status) params.set("status", status);
    if (perfil === "admin" && setorFiltro) params.set("setor", setorFiltro);
    if (plataformaFiltro) params.set("plataforma", plataformaFiltro);
    if (responsavelFiltro) params.set("responsavel", responsavelFiltro);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    params.set("limit", String(POR_PAGINA));
    params.set("offset", String(pagina * POR_PAGINA));
    return params.toString();
  }, [texto, status, setorFiltro, plataformaFiltro, responsavelFiltro, dateFrom, dateTo, pagina, perfil]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const query = montarQuery();
      const resposta = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3335"}/api/v1/nao-conformidades?${query}`,
        { credentials: "include" }
      );
      if (!resposta.ok) {
        const corpo = await resposta.json().catch(() => ({}));
        throw new Error((corpo as { erro?: string }).erro ?? "Erro ao carregar não conformidades.");
      }
      setItens((await resposta.json()) as NaoConformidadePublica[]);
      setTotal(Number(resposta.headers.get("X-Total-Count") ?? 0));
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar não conformidades."));
    } finally {
      setCarregando(false);
    }
  }, [montarQuery]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => {
    setPagina(0);
  }, [texto, status, setorFiltro, plataformaFiltro, responsavelFiltro, dateFrom, dateTo]);

  const filtrosAvancadosAtivos = useMemo(
    () => [setorFiltro, plataformaFiltro, responsavelFiltro, dateFrom, dateTo].filter(Boolean).length,
    [setorFiltro, plataformaFiltro, responsavelFiltro, dateFrom, dateTo]
  );

  function limparTudo() {
    setTexto("");
    setStatus("");
    setSetorFiltro("");
    setPlataformaFiltro("");
    setResponsavelFiltro("");
    setDateFrom("");
    setDateTo("");
  }

  function aoAtualizarStatus(atualizada: NaoConformidadePublica) {
    setItens((atual) => atual.map((item) => (item.id === atualizada.id ? atualizada : item)));
    setSelecionada(atualizada);
  }

  const temQualquerFiltro = Boolean(texto || status || setorFiltro || plataformaFiltro || responsavelFiltro || dateFrom || dateTo);

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Não conformidades</h1>
          <p>Acompanhamento das ocorrências registradas</p>
        </div>
      </div>

      <FiltrosAvancados
        ativos={filtrosAvancadosAtivos}
        contagem={carregando && itens.length === 0 ? "Carregando..." : `${total} registro(s)`}
        onLimpar={limparTudo}
        avancados={
          <>
            {perfil === "admin" && (
              <CampoFiltro label="Setor" htmlFor="nc-setor">
                <select id="nc-setor" value={setorFiltro} onChange={(e) => setSetorFiltro(e.target.value)}>
                  <option value="">Todos</option>
                  {setoresOpcoes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome}
                    </option>
                  ))}
                </select>
              </CampoFiltro>
            )}
            <CampoFiltro label="Plataforma" htmlFor="nc-plataforma">
              <select id="nc-plataforma" value={plataformaFiltro} onChange={(e) => setPlataformaFiltro(e.target.value)}>
                <option value="">Todas</option>
                {plataformasOpcoes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
              </select>
            </CampoFiltro>
            <CampoFiltro label="Responsável" htmlFor="nc-responsavel">
              <select id="nc-responsavel" value={responsavelFiltro} onChange={(e) => setResponsavelFiltro(e.target.value)}>
                <option value="">Todos</option>
                {usuariosOpcoes.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nome}
                  </option>
                ))}
              </select>
            </CampoFiltro>
            <CampoFiltro label="De" htmlFor="nc-de">
              <input id="nc-de" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
            </CampoFiltro>
            <CampoFiltro label="Até" htmlFor="nc-ate">
              <input id="nc-ate" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
            </CampoFiltro>
          </>
        }
      >
        <label htmlFor="nc-texto" className={styles.visuallyHidden}>
          Buscar por descrição
        </label>
        <input
          id="nc-texto"
          type="search"
          className={styles.search}
          placeholder="Buscar por descrição..."
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <label htmlFor="nc-status" className={styles.visuallyHidden}>
          Filtrar por status
        </label>
        <select id="nc-status" className={styles.selectStatus} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {STATUS_NAO_CONFORMIDADE.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </FiltrosAvancados>

      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Data/hora</th>
              <th scope="col">Plataforma</th>
              <th scope="col">Setor</th>
              <th scope="col">Autor</th>
              <th scope="col">Descrição</th>
              <th scope="col">Imagem</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody aria-busy={carregando}>
            {!carregando && itens.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className={styles.empty}>
                    {temQualquerFiltro ? "Nenhuma não conformidade encontrada com esses filtros." : "Nenhuma não conformidade registrada."}
                  </div>
                </td>
              </tr>
            ) : (
              itens.map((item) => (
                <tr
                  key={item.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Detalhes da não conformidade de ${formatarCarimbo(item.criadoEm)}`}
                  onClick={() => setSelecionada(item)}
                  onKeyDown={(evento) => {
                    if (evento.key === "Enter" || evento.key === " ") {
                      evento.preventDefault();
                      setSelecionada(item);
                    }
                  }}
                >
                  <td className={styles.celulaData}>{formatarCarimbo(item.criadoEm)}</td>
                  <td>{item.plataformaNome}</td>
                  <td>{item.setorNome}</td>
                  <td>{item.autorNome}</td>
                  <td>
                    <span className={styles.descricao} title={item.descricao}>
                      {item.descricao || "—"}
                    </span>
                  </td>
                  <td>
                    {item.imagens.length > 0 ? (
                      <span className={styles.miniatura}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.imagens[0].url} alt="" />
                      </span>
                    ) : (
                      <ImageOff size={16} strokeWidth={1.5} className={styles.semImagem} aria-label="Sem imagem" />
                    )}
                  </td>
                  <td>
                    <span className={`${styles.badge} ${styles[`badge_${item.status}`]}`}>{STATUS_LABELS[item.status]}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Paginacao total={total} pagina={pagina} porPagina={POR_PAGINA} carregando={carregando} onMudarPagina={setPagina} rotuloItens="não conformidade(s)" />

      {selecionada && (
        <NaoConformidadeDetalheDrawer
          item={selecionada}
          podeAlterarStatus={podeTratarStatus && (perfil === "admin" || selecionada.setorId === setorId)}
          onClose={() => setSelecionada(null)}
          onStatusAlterado={aoAtualizarStatus}
        />
      )}
    </section>
  );
}
