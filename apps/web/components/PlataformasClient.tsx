"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "../app/(app)/plataformas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { useEventosSSE } from "../lib/useEventosSSE";
import { StatusBadge } from "./StatusBadge";
import { PlataformaModal, type PlataformaEditavel, type PlataformaFormValues } from "./PlataformaModal";
import { formatarHorimetro, formatarTelefone, telefoneParaLink } from "@plataformares/shared";

interface EventoAtivoPlataforma {
  texto: string;
  detalhe: string | null;
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  telefoneEmergencia: string | null;
  capacidade: number | null;
  status: "disponivel" | "reservada" | "manutencao" | "inativa";
  categoria: string;
  risco: string;
  observacoes: string | null;
  imagemUrl: string | null;
  tipoEquipamento: string | null;
  alturaMaximaM: number | null;
  capacidadeOperadores: number | null;
  horimetroHoras: number | null;
  // Horímetro automático (migration 0022): baseline + uso real das reservas concluídas.
  horimetroAtualHoras?: number | null;
  horimetroUsoMinutos?: number;
  utilizacao30d: number | null;
  evento: EventoAtivoPlataforma | null;
  normas: string[];

  checklistTotalQuestoes: number | null;
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
}

export function PlataformasClient({ isAdmin }: { isAdmin: boolean }) {
  const [plataformas, setPlataformas] = useState<Plataforma[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState("");
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<PlataformaEditavel | null>(null);
  // Atalho "Editar template" do card: abre o editor de templates direto no template
  // vinculado, sem passar pelo formulário do equipamento.


  // Só a busca por texto é adiada; trocar o filtro de status responde imediatamente.
  const buscaComAtraso = useDebounce(busca);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const params = new URLSearchParams();
      if (buscaComAtraso) params.set("q", buscaComAtraso);
      if (statusFiltro) params.set("status", statusFiltro);
      const query = params.toString();
      const dados = await apiFetch<Plataforma[]>(`/api/v1/plataformas${query ? `?${query}` : ""}`);
      setPlataformas(dados);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar plataformas."));
    } finally {
      setCarregando(false);
    }
  }, [buscaComAtraso, statusFiltro]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // O status derivado ("Reservada") muda sozinho conforme as reservas entram em uso —
  // sem SSE, o card só refletia isso depois de um F5.
  useEventosSSE({
    onEvento: (tipo) => {
      if (tipo === "plataforma.status_alterado" || tipo === "reserva.status_alterado") {
        carregar();
      }
    },
  });

  async function handleSalvar(valores: PlataformaFormValues) {
    const { status: novoStatus, ...campos } = valores;
    if (editando) {
      // `risco` continua fora do formulário — sem reenviá-lo, o zod aplicaria o default
      // ("baixo") e apagaria a classificação real da plataforma a cada edição. `categoria`
      // agora vem do próprio formulário.
      await apiFetch(`/api/v1/plataformas/${editando.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...campos, risco: editando.risco }),
      });
      if (novoStatus && novoStatus !== editando.status) {
        await apiFetch(`/api/v1/plataformas/${editando.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: novoStatus }),
        });
      }
    } else {
      await apiFetch("/api/v1/plataformas", {
        method: "POST",
        body: JSON.stringify(campos),
      });
    }
    setModalAberto(false);
    setEditando(null);
    await carregar();
  }

  async function handleToggleStatus(plataforma: Plataforma) {
    const novoStatus = plataforma.status === "inativa" ? "disponivel" : "inativa";
    setErro(null);
    try {
      await apiFetch(`/api/v1/plataformas/${plataforma.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: novoStatus }),
      });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status.");
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          {/* "Frota" — o mesmo nome que a sidebar e o breadcrumb já usam. A página se
              chamava "Plataformas" e obrigava o usuário a traduzir mentalmente entre o
              item de menu que clicou e o título que abriu. */}
          <h1>Frota</h1>
          <p>Equipamentos e espaços compartilhados</p>
        </div>
        {isAdmin && (
          <div className={styles.headerAcoes}>
            <Link href="/plataformas/bloqueios" className={styles.btnGhost}>
              Bloqueios de Agenda
            </Link>
            <button
              className={styles.btnPrimary}
              onClick={() => {
                setEditando(null);
                setModalAberto(true);
              }}
            >
              Nova Plataforma
            </button>
          </div>
        )}
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          placeholder="Buscar por nome, código ou localização..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className={styles.search}
          aria-label="Buscar plataforma"
        />
        <select
          value={statusFiltro}
          onChange={(e) => setStatusFiltro(e.target.value)}
          aria-label="Filtrar por status"
        >
          <option value="">Todos os status</option>
          <option value="disponivel">Disponível</option>
          <option value="reservada">Reservada</option>
          <option value="manutencao">Em Manutenção</option>
          <option value="inativa">Inativa</option>
        </select>
      </div>

      {erro && (
        <div className={styles.error} role="alert">
          {erro}
        </div>
      )}

      {carregando && plataformas.length === 0 ? (
        <div className={styles.empty}>Carregando...</div>
      ) : plataformas.length === 0 ? (
        <div className={styles.empty}>
          {busca || statusFiltro ? "Nenhuma plataforma encontrada." : "Nenhuma plataforma cadastrada."}
        </div>
      ) : (
        <div className={styles.grid}>
          {plataformas.map((p) => {
            // Ficha técnica resumida: o que ajuda a ESCOLHER um equipamento numa lista
            // (tipo, alcance, capacidade). Antes a altura aparecia duas vezes — no
            // subtítulo e de novo na grade de metadados logo abaixo.
            const ficha = [
              p.tipoEquipamento,
              p.alturaMaximaM ? `${p.alturaMaximaM} m` : null,
              p.capacidadeOperadores ? `${p.capacidadeOperadores} pessoas` : null,
              p.capacidade ? `${p.capacidade} kg` : null,
            ]
              .filter(Boolean)
              .join(" · ");

            // Detalhes que não participam da escolha e só interessam quando o usuário já
            // está olhando aquele equipamento em particular.
            const horimetroAtual = p.horimetroAtualHoras ?? p.horimetroHoras;
            const temDetalhes =
              horimetroAtual !== null ||
              p.utilizacao30d !== null ||
              Boolean(p.observacoes) ||
              Boolean(p.telefoneEmergencia);

            return (
              <div className={styles.card} key={p.id}>
                <div className={styles.cardImageWrap}>
                  {p.imagemUrl ? (
                    <img
                      src={p.imagemUrl}
                      // A imagem é decorativa: nome, código e status já estão no texto do
                      // card logo abaixo. Um alt repetindo o nome faria o leitor de tela
                      // anunciar a mesma informação duas vezes por plataforma.
                      alt=""
                      className={styles.cardImage}
                      // Uma frota com dezenas de plataformas baixava TODAS as imagens no
                      // primeiro paint, mesmo as que estavam muitas telas abaixo.
                      loading="lazy"
                      decoding="async"
                      // SAS expirado / blob removido deixava um ícone de imagem quebrada;
                      // agora o card cai para o mesmo placeholder de "sem imagem".
                      onError={(evento) => {
                        evento.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <div className={styles.cardImagePlaceholder}>Sem imagem</div>
                  )}
                  <div className={styles.cardBadge}>
                    <StatusBadge status={p.status} />
                  </div>
                  {p.normas.length > 0 && (
                    <div className={styles.cardNormas}>
                      {p.normas.map((norma) => (
                        <span key={norma} className={styles.normaPill}>
                          {norma}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Hierarquia do card, do topo: nome (protagonista) → "código · local"
                    (como identificar/onde achar) → ficha resumida em uma linha. Antes
                    vinham código, nome, subtítulo e uma grade de quatro pares
                    rótulo/valor — dez fragmentos de texto antes de qualquer ação. */}
                <div className={styles.cardBody}>
                  <h3 className={styles.cardTitle} title={p.nome}>
                    {p.nome}
                  </h3>
                  <span className={styles.cardIdent}>
                    {p.codigo}
                    {p.localizacao ? ` · ${p.localizacao}` : ""}
                  </span>
                  {ficha && <span className={styles.cardFicha}>{ficha}</span>}

                  {/* Telefone de emergência: dado operacionalmente crítico, mas não é o
                      que identifica o equipamento — fica em "Detalhes" (progressive
                      disclosure) e aparece em destaque onde é realmente necessário, no
                      detalhe da reserva. */}

                  {/* Exceção operacional (bloqueio/manutenção ativa): é o motivo de o
                      usuário não poder reservar agora, então nunca é escondida. */}
                  {p.evento && (
                    <div className={styles.cardEvento}>
                      <span className={styles.cardEventoTexto}>{p.evento.texto}</span>
                      {p.evento.detalhe && <span className={styles.cardEventoDetalhe}>{p.evento.detalhe}</span>}
                    </div>
                  )}

                  {/* <details> nativo: horímetro, utilização e observações continuam
                      acessíveis (inclusive por teclado e leitor de tela) sem ocupar altura
                      em todos os cards da grade o tempo todo. */}
                  {temDetalhes && (
                    <details className={styles.cardDetalhes}>
                      <summary>Detalhes</summary>
                      <div className={styles.cardDetalhesCorpo}>
                        {horimetroAtual !== null && (
                          <div
                            className={styles.cardMetaItem}
                            title="Atualizado automaticamente pelo uso real das reservas concluídas."
                          >
                            <span className={styles.cardMetaLabel}>Horímetro atual</span>
                            <span className={styles.cardMetaValue}>{formatarHorimetro(horimetroAtual)}</span>
                          </div>
                        )}
                        {p.utilizacao30d !== null && (
                          <div className={styles.utilBlock}>
                            <div className={styles.utilLabelRow}>
                              <span className={styles.cardMetaLabel}>Utilização · 30D</span>
                              <span className={styles.utilPercent}>{p.utilizacao30d}%</span>
                            </div>
                            <div className={styles.utilTrack}>
                              <div
                                className={styles.utilFill}
                                style={{ width: `${Math.min(p.utilizacao30d, 100)}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {p.telefoneEmergencia && (
                          <div className={styles.cardMetaItem}>
                            <span className={styles.cardMetaLabel}>Emergência</span>
                            <a
                              className={styles.cardMetaValue}
                              href={`tel:${telefoneParaLink(p.telefoneEmergencia)}`}
                            >
                              {formatarTelefone(p.telefoneEmergencia)}
                            </a>
                          </div>
                        )}
                        {p.observacoes && <p className={styles.cardNote}>{p.observacoes}</p>}
                      </div>
                    </details>
                  )}
                </div>

                {isAdmin && (
                  <div className={styles.cardFooter}>
                    <button
                      type="button"
                      className={styles.btnIcon}
                      onClick={() => {
                        setEditando(p);
                        setModalAberto(true);
                      }}
                    >
                      Editar
                    </button>
                    {/* Ativar/desativar não é destrutivo e é reversível num clique — em
                        vermelho, competia com o estado real do equipamento na mesma área
                        do card. Vira ação secundária discreta. */}
                    <button type="button" className={styles.btnIcon} onClick={() => handleToggleStatus(p)}>
                      {p.status === "inativa" ? "Ativar" : "Desativar"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalAberto && (
        <PlataformaModal
          plataforma={editando}
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
