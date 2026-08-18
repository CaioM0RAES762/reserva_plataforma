"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "../app/(app)/plataformas/page.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useDebounce } from "../lib/useDebounce";
import { useEventosSSE } from "../lib/useEventosSSE";
import { StatusBadge } from "./StatusBadge";
import { PlataformaModal, type PlataformaEditavel, type PlataformaFormValues } from "./PlataformaModal";
import { ChecklistTemplatesModal } from "./ChecklistTemplatesModal";

interface EventoAtivoPlataforma {
  texto: string;
  detalhe: string | null;
}

interface Plataforma {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
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
  utilizacao30d: number | null;
  evento: EventoAtivoPlataforma | null;
  normas: string[];
  exigeChecklist: boolean;
  checklistTemplateId: string | null;
  checklistTemplateNome: string | null;
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
  const [templateEmEdicao, setTemplateEmEdicao] = useState<string | null>(null);

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
          <h1>Plataformas</h1>
          <p>Gerencie os equipamentos e espaços compartilhados</p>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8 }}>
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
        <div className={styles.empty}>Carregando plataformas...</div>
      ) : plataformas.length === 0 ? (
        <div className={styles.empty}>
          {busca || statusFiltro
            ? "Nenhuma plataforma corresponde aos filtros aplicados."
            : isAdmin
              ? "Nenhuma plataforma cadastrada. Use “Nova Plataforma” para cadastrar a primeira."
              : "Nenhuma plataforma cadastrada."}
        </div>
      ) : (
        <div className={styles.grid}>
          {plataformas.map((p) => {
            const subtitulo = [p.tipoEquipamento, p.alturaMaximaM ? `${p.alturaMaximaM} m` : null]
              .filter(Boolean)
              .join(" · ");
            const operadoresValor = [
              p.capacidadeOperadores ? `${p.capacidadeOperadores}` : null,
              p.capacidade ? `${p.capacidade} kg` : null,
            ]
              .filter(Boolean)
              .join(" · ");

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

                <div className={styles.cardBody}>
                  <span className={styles.cardEyebrow}>{p.codigo}</span>
                  <h3 className={styles.cardTitle}>{p.nome}</h3>
                  {subtitulo && <span className={styles.cardSubtitle}>{subtitulo}</span>}

                  <div className={styles.cardMeta}>
                    <div className={styles.cardMetaItem}>
                      <span className={styles.cardMetaLabel}>Localização</span>
                      <span className={styles.cardMetaValue}>{p.localizacao ?? "—"}</span>
                    </div>
                    <div className={styles.cardMetaItem}>
                      <span className={styles.cardMetaLabel}>Operadores</span>
                      <span className={styles.cardMetaValue}>{operadoresValor || "—"}</span>
                    </div>
                    <div className={styles.cardMetaItem}>
                      <span className={styles.cardMetaLabel}>Altura máx.</span>
                      <span className={styles.cardMetaValue}>{p.alturaMaximaM ? `${p.alturaMaximaM} m` : "—"}</span>
                    </div>
                    <div className={styles.cardMetaItem}>
                      <span className={styles.cardMetaLabel}>Horímetro</span>
                      <span className={styles.cardMetaValue}>
                        {p.horimetroHoras !== null ? `${p.horimetroHoras.toLocaleString("pt-BR")} h` : "—"}
                      </span>
                    </div>
                  </div>

                  {p.utilizacao30d !== null && (
                    <div className={styles.utilBlock}>
                      <div className={styles.utilLabelRow}>
                        <span className={styles.cardMetaLabel}>Utilização · 30D</span>
                        <span className={styles.utilPercent}>{p.utilizacao30d}%</span>
                      </div>
                      <div className={styles.utilTrack}>
                        <div className={styles.utilFill} style={{ width: `${Math.min(p.utilizacao30d, 100)}%` }} />
                      </div>
                    </div>
                  )}

                  {/* Configuração de segurança visível direto no card, com atalho para o
                      mesmo editor de templates da área de Checklists — "esta plataforma
                      exige checklist?" é a pergunta que explica o fluxo da reserva dela. */}
                  {p.exigeChecklist && p.checklistTemplateNome && (
                    <div className={styles.cardChecklist}>
                      <span className={styles.cardMetaLabel}>Checklist de segurança</span>
                      <span className={styles.cardChecklistNome}>{p.checklistTemplateNome}</span>
                      <span className={styles.cardChecklistMeta}>
                        {p.checklistTotalQuestoes ?? 0}{" "}
                        {p.checklistTotalQuestoes === 1 ? "questão" : "questões"}
                      </span>
                      {isAdmin && (
                        <button
                          type="button"
                          className={styles.cardChecklistAcao}
                          onClick={() => setTemplateEmEdicao(p.checklistTemplateId)}
                        >
                          Editar template
                        </button>
                      )}
                    </div>
                  )}

                  {p.evento ? (
                    <div className={styles.cardEvento}>
                      <span className={styles.cardEventoTexto}>{p.evento.texto}</span>
                      {p.evento.detalhe && <span className={styles.cardEventoDetalhe}>{p.evento.detalhe}</span>}
                    </div>
                  ) : (
                    p.observacoes && <p className={styles.cardNote}>{p.observacoes}</p>
                  )}
                </div>

                {isAdmin && (
                  <div className={styles.cardFooter}>
                    <button
                      className={styles.btnIcon}
                      onClick={() => {
                        setEditando(p);
                        setModalAberto(true);
                      }}
                    >
                      Editar
                    </button>
                    <button className={styles.btnIconDanger} onClick={() => handleToggleStatus(p)}>
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

      {templateEmEdicao && (
        <ChecklistTemplatesModal
          templateIdInicial={templateEmEdicao}
          onClose={() => {
            setTemplateEmEdicao(null);
            void carregar();
          }}
          // A contagem de questões aparece no card — precisa acompanhar a edição.
          onAlterado={() => void carregar()}
        />
      )}
    </section>
  );
}
