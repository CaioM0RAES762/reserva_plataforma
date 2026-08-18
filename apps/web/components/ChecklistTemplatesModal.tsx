"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import styles from "./ChecklistTemplatesModal.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";

// ÚNICO editor de templates de checklist do sistema. É aberto tanto pela área
// "Checklists NR-18/35" (botão "Gerenciar templates") quanto pelo cadastro da Frota
// (seção Segurança → "Editar template" / "Criar novo template"). Não existem dois
// sistemas de edição: as duas telas montam este mesmo componente.

export interface ChecklistTemplateResumo {
  id: string;
  nome: string;
  descricao: string | null;
  categoriaPlataforma: string;
  ativo: boolean;
  totalQuestoes: number;
  totalPlataformasVinculadas: number;
}

export interface ChecklistQuestao {
  id: string;
  templateId: string;
  descricao: string;
  ordem: number;
  obrigatorio: boolean;
  bloqueiaAprovacao: boolean;
  ativo: boolean;
}

interface TemplateDetalhe extends ChecklistTemplateResumo {
  itens: ChecklistQuestao[];
}

const CATEGORIAS: Array<{ valor: string; rotulo: string }> = [
  { valor: "elevatoria", rotulo: "Plataforma elevatória" },
  { valor: "andaime", rotulo: "Andaime" },
  { valor: "veiculo", rotulo: "Veículo" },
  { valor: "sala", rotulo: "Sala / espaço compartilhado" },
  { valor: "patio", rotulo: "Pátio" },
  { valor: "outro", rotulo: "Outro" },
];

function rotuloCategoria(valor: string): string {
  return CATEGORIAS.find((c) => c.valor === valor)?.rotulo ?? valor;
}

interface ChecklistTemplatesModalProps {
  onClose: () => void;
  // Chamado quando algo muda (template criado/editado, questão alterada) para que a tela
  // de origem recarregue suas contagens — a Frota exibe "6 questões", a área de Checklists
  // exibe o nome do template em cada linha.
  onAlterado?: () => void;
  // Abre direto no editor deste template (atalho "Editar template" da Frota), pulando a
  // lista. Sem isto, o modal abre na visão de gerenciamento.
  templateIdInicial?: string;
  // Abre direto no formulário de criação ("+ Criar novo template" da Frota).
  iniciarCriando?: boolean;
  // Quando informado, o editor mostra "Usar este template" ao salvar — é o retorno para o
  // formulário da plataforma, que associa o template recém-criado sem o Admin ter de sair
  // da tela, ir até Checklists, criar e voltar.
  onSelecionarTemplate?: (template: ChecklistTemplateResumo) => void;
}

export function ChecklistTemplatesModal({
  onClose,
  onAlterado,
  templateIdInicial,
  iniciarCriando = false,
  onSelecionarTemplate,
}: ChecklistTemplatesModalProps) {
  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(
    onClose,
    "checklist-templates"
  );

  const [modo, setModo] = useState<"lista" | "editor">(
    templateIdInicial || iniciarCriando ? "editor" : "lista"
  );
  const [templates, setTemplates] = useState<ChecklistTemplateResumo[]>([]);
  const [editando, setEditando] = useState<TemplateDetalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Campos do template em edição
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState("outro");
  const [ativo, setAtivo] = useState(true);

  // Formulário de questão (nova ou em edição)
  const [questaoTexto, setQuestaoTexto] = useState("");
  const [questaoObrigatoria, setQuestaoObrigatoria] = useState(true);
  const [questaoBloqueia, setQuestaoBloqueia] = useState(true);
  const [questaoEditandoId, setQuestaoEditandoId] = useState<string | null>(null);
  const [formQuestaoAberto, setFormQuestaoAberto] = useState(false);

  const carregarLista = useCallback(async () => {
    setErro(null);
    try {
      const dados = await apiFetch<ChecklistTemplateResumo[]>(
        "/api/v1/checklist-modelos?incluirInativos=true"
      );
      setTemplates(dados);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar os templates."));
    } finally {
      setCarregando(false);
    }
  }, []);

  const abrirEditor = useCallback(async (templateId: string) => {
    setErro(null);
    setCarregando(true);
    try {
      const dados = await apiFetch<TemplateDetalhe>(`/api/v1/checklist-modelos/${templateId}`);
      setEditando(dados);
      setNome(dados.nome);
      setDescricao(dados.descricao ?? "");
      setCategoria(dados.categoriaPlataforma);
      setAtivo(dados.ativo);
      setModo("editor");
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao carregar o template."));
    } finally {
      setCarregando(false);
    }
  }, []);

  function abrirCriacao() {
    setEditando(null);
    setNome("");
    setDescricao("");
    setCategoria("outro");
    setAtivo(true);
    setErro(null);
    setModo("editor");
  }

  useEffect(() => {
    if (templateIdInicial) {
      void abrirEditor(templateIdInicial);
      return;
    }
    if (iniciarCriando) {
      abrirCriacao();
      setCarregando(false);
      return;
    }
    void carregarLista();
  }, [templateIdInicial, iniciarCriando, abrirEditor, carregarLista]);

  function voltarParaLista() {
    setModo("lista");
    setEditando(null);
    setFormQuestaoAberto(false);
    setQuestaoEditandoId(null);
    setErro(null);
    void carregarLista();
  }

  async function salvarTemplate(): Promise<ChecklistTemplateResumo | null> {
    if (nome.trim().length < 3) {
      setErro("O nome do template deve ter no mínimo 3 caracteres.");
      return null;
    }
    setSalvando(true);
    setErro(null);
    try {
      const corpo = {
        nome: nome.trim(),
        descricao: descricao.trim() || undefined,
        categoriaPlataforma: categoria,
        ativo,
      };
      const salvo = editando
        ? await apiFetch<ChecklistTemplateResumo>(`/api/v1/checklist-modelos/${editando.id}`, {
            method: "PUT",
            body: JSON.stringify(corpo),
          })
        : await apiFetch<TemplateDetalhe>("/api/v1/checklist-modelos", {
            method: "POST",
            body: JSON.stringify(corpo),
          });
      // Depois de criar, o editor continua aberto no template recém-criado — é aqui que as
      // questões são adicionadas, e mandar o Admin reabrir o registro para isso seria um
      // passo a mais sem motivo.
      if (!editando) {
        await abrirEditor(salvo.id);
      } else {
        setEditando({ ...editando, ...salvo, itens: editando.itens });
      }
      onAlterado?.();
      return salvo;
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao salvar o template."));
      return null;
    } finally {
      setSalvando(false);
    }
  }

  async function recarregarQuestoes(templateId: string) {
    const dados = await apiFetch<TemplateDetalhe>(`/api/v1/checklist-modelos/${templateId}`);
    setEditando(dados);
    onAlterado?.();
  }

  function abrirFormQuestao(questao?: ChecklistQuestao) {
    setQuestaoEditandoId(questao?.id ?? null);
    setQuestaoTexto(questao?.descricao ?? "");
    setQuestaoObrigatoria(questao?.obrigatorio ?? true);
    setQuestaoBloqueia(questao?.bloqueiaAprovacao ?? true);
    setFormQuestaoAberto(true);
    setErro(null);
  }

  async function salvarQuestao() {
    if (!editando) return;
    if (questaoTexto.trim().length < 3) {
      setErro("O enunciado da questão deve ter no mínimo 3 caracteres.");
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      const corpo = {
        descricao: questaoTexto.trim(),
        obrigatorio: questaoObrigatoria,
        bloqueiaAprovacao: questaoBloqueia,
      };
      if (questaoEditandoId) {
        await apiFetch(`/api/v1/checklist-itens/${questaoEditandoId}`, {
          method: "PUT",
          body: JSON.stringify(corpo),
        });
      } else {
        await apiFetch(`/api/v1/checklist-modelos/${editando.id}/itens`, {
          method: "POST",
          body: JSON.stringify(corpo),
        });
      }
      await recarregarQuestoes(editando.id);
      setFormQuestaoAberto(false);
      setQuestaoEditandoId(null);
      setQuestaoTexto("");
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao salvar a questão."));
    } finally {
      setSalvando(false);
    }
  }

  async function removerQuestao(questao: ChecklistQuestao) {
    if (!editando) return;
    if (
      !confirm(
        `Remover a questão "${questao.descricao}"?\n\nEla deixa de aparecer em novos checklists. Checklists já realizados continuam mostrando a pergunta e a resposta registradas.`
      )
    ) {
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await apiFetch(`/api/v1/checklist-itens/${questao.id}`, { method: "DELETE" });
      await recarregarQuestoes(editando.id);
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao remover a questão."));
    } finally {
      setSalvando(false);
    }
  }

  // Reordenação por botões subir/descer: a lista inteira é reenviada na nova ordem, que é
  // como o backend renumera (evita duas questões na mesma posição). Botões, e não
  // drag-and-drop, porque funcionam por teclado e em toque sem biblioteca adicional.
  async function moverQuestao(indice: number, direcao: -1 | 1) {
    if (!editando) return;
    const itens = [...editando.itens];
    const destino = indice + direcao;
    if (destino < 0 || destino >= itens.length) return;
    [itens[indice], itens[destino]] = [itens[destino], itens[indice]];
    // Atualização otimista: a lista já aparece reordenada enquanto o PUT viaja.
    setEditando({ ...editando, itens });
    try {
      await apiFetch(`/api/v1/checklist-modelos/${editando.id}/itens/ordem`, {
        method: "PUT",
        body: JSON.stringify({ itemIds: itens.map((i) => i.id) }),
      });
      onAlterado?.();
    } catch (err) {
      setErro(mensagemDeErro(err, "Erro ao reordenar as questões."));
      await recarregarQuestoes(editando.id);
    }
  }

  async function usarEsteTemplate() {
    if (!onSelecionarTemplate) return;
    const salvo = await salvarTemplate();
    const alvo = salvo ?? editando;
    if (alvo) {
      onSelecionarTemplate({
        id: alvo.id,
        nome: alvo.nome,
        descricao: alvo.descricao ?? null,
        categoriaPlataforma: alvo.categoriaPlataforma,
        ativo: alvo.ativo,
        totalQuestoes: editando?.itens.length ?? alvo.totalQuestoes,
        totalPlataformasVinculadas: alvo.totalPlataformasVinculadas,
      });
    }
  }

  return (
    <div className={styles.overlay} onClick={aoClicarNoOverlay}>
      <div className={styles.modal} ref={refDialogo} {...propsDialogo}>
        <div className={styles.header}>
          <div>
            <h3 id={idTitulo}>
              {modo === "lista"
                ? "Templates de checklist"
                : editando
                  ? "Editar template"
                  : "Novo template"}
            </h3>
            <p className={styles.headerSub}>
              {modo === "lista"
                ? "Modelos de checklist de segurança e os equipamentos que os utilizam."
                : "As alterações valem para novos checklists; execuções já realizadas permanecem como foram registradas."}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {erro && (
            <div className={styles.erro} role="alert">
              {erro}
            </div>
          )}

          {carregando ? (
            <div className={styles.vazio}>Carregando…</div>
          ) : modo === "lista" ? (
            <div className={styles.lista}>
              {templates.length === 0 ? (
                <div className={styles.vazio}>Nenhum template cadastrado ainda.</div>
              ) : (
                templates.map((template) => (
                  <div
                    key={template.id}
                    className={`${styles.cartao} ${template.ativo ? "" : styles.cartaoInativo}`}
                  >
                    <div>
                      <div className={styles.cartaoNome}>
                        {template.nome}
                        {!template.ativo && <span className={styles.selo}>Inativo</span>}
                      </div>
                      {template.descricao && (
                        <div className={styles.cartaoDescricao}>{template.descricao}</div>
                      )}
                      <div className={styles.cartaoMeta}>
                        {template.totalQuestoes} {template.totalQuestoes === 1 ? "questão" : "questões"} ·{" "}
                        {template.totalPlataformasVinculadas}{" "}
                        {template.totalPlataformasVinculadas === 1
                          ? "plataforma vinculada"
                          : "plataformas vinculadas"}{" "}
                        · {rotuloCategoria(template.categoriaPlataforma)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={styles.btnGhost}
                      onClick={() => void abrirEditor(template.id)}
                    >
                      Editar
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              <div className={styles.campos}>
                <div className={styles.campo}>
                  <label htmlFor="tpl-nome">Nome do template</label>
                  <input
                    id="tpl-nome"
                    type="text"
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Ex: Checklist NR-18/35 — Plataforma Elevatória"
                  />
                </div>
                <div className={styles.campo}>
                  <label htmlFor="tpl-descricao">Descrição</label>
                  <textarea
                    id="tpl-descricao"
                    rows={2}
                    value={descricao}
                    onChange={(e) => setDescricao(e.target.value)}
                    placeholder="Quando este checklist deve ser usado..."
                  />
                </div>
                <div className={styles.linhaDupla}>
                  <div className={styles.campo}>
                    <label htmlFor="tpl-categoria">Categoria de equipamento</label>
                    <select
                      id="tpl-categoria"
                      value={categoria}
                      onChange={(e) => setCategoria(e.target.value)}
                    >
                      {CATEGORIAS.map((c) => (
                        <option key={c.valor} value={c.valor}>
                          {c.rotulo}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.campo}>
                    <label htmlFor="tpl-ativo">Situação</label>
                    <label className={styles.checkLinha}>
                      <input
                        id="tpl-ativo"
                        type="checkbox"
                        checked={ativo}
                        onChange={(e) => setAtivo(e.target.checked)}
                      />
                      Template ativo
                    </label>
                    <p className={styles.checkAjuda}>
                      Templates inativos não podem ser associados a novas plataformas.
                    </p>
                  </div>
                </div>
              </div>

              {editando ? (
                <>
                  <div className={styles.secaoTitulo}>
                    <h4>Questões</h4>
                    <button
                      type="button"
                      className={styles.btnGhost}
                      onClick={() => abrirFormQuestao()}
                      disabled={formQuestaoAberto}
                    >
                      <Plus size={14} strokeWidth={2} aria-hidden="true" /> Adicionar questão
                    </button>
                  </div>

                  {formQuestaoAberto && (
                    <div className={styles.questao} style={{ flexDirection: "column", gap: 12 }}>
                      <div className={styles.campo} style={{ width: "100%" }}>
                        <label htmlFor="q-texto">
                          {questaoEditandoId ? "Editar questão" : "Nova questão"}
                        </label>
                        <input
                          id="q-texto"
                          type="text"
                          value={questaoTexto}
                          onChange={(e) => setQuestaoTexto(e.target.value)}
                          placeholder="Ex: Guarda-corpo em boas condições"
                        />
                      </div>
                      <label className={styles.checkLinha}>
                        <input
                          type="checkbox"
                          checked={questaoObrigatoria}
                          onChange={(e) => setQuestaoObrigatoria(e.target.checked)}
                        />
                        Obrigatória — precisa ser respondida para finalizar o checklist
                      </label>
                      <label className={styles.checkLinha}>
                        <input
                          type="checkbox"
                          checked={questaoBloqueia}
                          onChange={(e) => setQuestaoBloqueia(e.target.checked)}
                        />
                        Não conformidade impede a aprovação da reserva
                      </label>
                      <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                        <button
                          type="button"
                          className={styles.btnGhost}
                          onClick={() => {
                            setFormQuestaoAberto(false);
                            setQuestaoEditandoId(null);
                          }}
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          onClick={() => void salvarQuestao()}
                          disabled={salvando}
                        >
                          {questaoEditandoId ? "Salvar questão" : "Adicionar"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className={styles.questoes} style={{ marginTop: 10 }}>
                    {editando.itens.length === 0 ? (
                      <div className={styles.vazio}>
                        Nenhuma questão neste template. Um template sem questões não bloqueia nada.
                      </div>
                    ) : (
                      editando.itens.map((questao, indice) => (
                        <div key={questao.id} className={styles.questao}>
                          <span className={styles.questaoNumero}>
                            {String(indice + 1).padStart(2, "0")}
                          </span>
                          <div className={styles.questaoCorpo}>
                            <div className={styles.questaoTexto}>{questao.descricao}</div>
                            <div className={styles.questaoRegras}>
                              <span
                                className={`${styles.regra} ${questao.obrigatorio ? styles.regraAtiva : ""}`}
                              >
                                {questao.obrigatorio ? "Obrigatória" : "Opcional"}
                              </span>
                              <span
                                className={`${styles.regra} ${questao.bloqueiaAprovacao ? styles.regraAtiva : ""}`}
                              >
                                {questao.bloqueiaAprovacao
                                  ? "Bloqueia aprovação"
                                  : "Não bloqueia aprovação"}
                              </span>
                            </div>
                          </div>
                          <div className={styles.questaoAcoes}>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => void moverQuestao(indice, -1)}
                              disabled={indice === 0 || salvando}
                              aria-label={`Mover "${questao.descricao}" para cima`}
                            >
                              <ArrowUp size={15} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => void moverQuestao(indice, 1)}
                              disabled={indice === editando.itens.length - 1 || salvando}
                              aria-label={`Mover "${questao.descricao}" para baixo`}
                            >
                              <ArrowDown size={15} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => abrirFormQuestao(questao)}
                              disabled={salvando}
                              aria-label={`Editar "${questao.descricao}"`}
                            >
                              <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              onClick={() => void removerQuestao(questao)}
                              disabled={salvando}
                              aria-label={`Remover "${questao.descricao}"`}
                            >
                              <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className={styles.aviso} style={{ marginTop: 18 }}>
                  Salve o template para começar a cadastrar as questões.
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          {modo === "editor" && !templateIdInicial && !iniciarCriando && (
            <button type="button" className={styles.btnGhost} onClick={voltarParaLista}>
              ← Todos os templates
            </button>
          )}
          <div className={styles.footerAcoes}>
            {modo === "lista" ? (
              <>
                <button type="button" className={styles.btnGhost} onClick={onClose}>
                  Fechar
                </button>
                <button type="button" className={styles.btnPrimary} onClick={abrirCriacao}>
                  <Plus size={14} strokeWidth={2} aria-hidden="true" /> Novo template
                </button>
              </>
            ) : (
              <>
                <button type="button" className={styles.btnGhost} onClick={onClose}>
                  Fechar
                </button>
                {onSelecionarTemplate ? (
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={() => void usarEsteTemplate()}
                    disabled={salvando}
                  >
                    {salvando ? "Salvando..." : "Salvar e usar este template"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={() => void salvarTemplate()}
                    disabled={salvando}
                  >
                    {salvando ? "Salvando..." : editando ? "Salvar alterações" : "Criar template"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
