"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "../app/(app)/plataformas/page.module.css";
import local from "./PlataformaModal.module.css";
import { apiFetch } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { ChecklistTemplatesModal, type ChecklistTemplateResumo } from "./ChecklistTemplatesModal";

export interface PlataformaFormValues {
  codigo: string;
  nome: string;
  localizacao?: string;
  capacidade?: number;
  observacoes?: string;
  status?: "disponivel" | "manutencao" | "inativa";
  imagemBase64?: string;
  removerImagem?: boolean;
  tipoEquipamento?: string;
  alturaMaximaM?: number;
  capacidadeOperadores?: number;
  horimetroHoras?: number;
  categoria?: string;
  exigeChecklist: boolean;
  checklistTemplateId?: string | null;
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
}

export interface PlataformaEditavel {
  id: string;
  codigo: string;
  nome: string;
  localizacao: string | null;
  capacidade: number | null;
  observacoes: string | null;
  status: string;
  categoria: string;
  risco: string;
  imagemUrl: string | null;
  tipoEquipamento: string | null;
  alturaMaximaM: number | null;
  capacidadeOperadores: number | null;
  horimetroHoras: number | null;
  exigeChecklist: boolean;
  checklistTemplateId: string | null;
  checklistTemplateNome: string | null;
  checklistTotalQuestoes: number | null;
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
}

const CATEGORIAS: Array<{ valor: string; rotulo: string }> = [
  { valor: "elevatoria", rotulo: "Plataforma elevatória" },
  { valor: "andaime", rotulo: "Andaime" },
  { valor: "veiculo", rotulo: "Veículo" },
  { valor: "sala", rotulo: "Sala / espaço compartilhado" },
  { valor: "patio", rotulo: "Pátio" },
  { valor: "outro", rotulo: "Outro" },
];

interface PlataformaModalProps {
  plataforma: PlataformaEditavel | null;
  onClose: () => void;
  onSalvar: (valores: PlataformaFormValues) => Promise<void>;
}

const TAMANHO_MAX_IMAGEM = 10 * 1024 * 1024;

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

export function PlataformaModal({ plataforma, onClose, onSalvar }: PlataformaModalProps) {
  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "plataforma-modal");
  const [codigo, setCodigo] = useState(plataforma?.codigo ?? "");
  const [nome, setNome] = useState(plataforma?.nome ?? "");
  const [localizacao, setLocalizacao] = useState(plataforma?.localizacao ?? "");
  const [capacidade, setCapacidade] = useState(plataforma?.capacidade?.toString() ?? "");
  const [observacoes, setObservacoes] = useState(plataforma?.observacoes ?? "");
  const [tipoEquipamento, setTipoEquipamento] = useState(plataforma?.tipoEquipamento ?? "");
  const [alturaMaximaM, setAlturaMaximaM] = useState(plataforma?.alturaMaximaM?.toString() ?? "");
  const [capacidadeOperadores, setCapacidadeOperadores] = useState(
    plataforma?.capacidadeOperadores?.toString() ?? ""
  );
  const [horimetroHoras, setHorimetroHoras] = useState(plataforma?.horimetroHoras?.toString() ?? "");
  const [status, setStatus] = useState(
    plataforma && plataforma.status !== "reservada" ? plataforma.status : "disponivel"
  );
  const [imagemPreview, setImagemPreview] = useState<string | null>(plataforma?.imagemUrl ?? null);
  const [imagemBase64, setImagemBase64] = useState<string | undefined>(undefined);
  const [removerImagem, setRemoverImagem] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const inputImagemRef = useRef<HTMLInputElement>(null);

  // A categoria nunca esteve no formulário: toda plataforma criada pela UI nascia como
  // "outro". Enquanto a exigência de checklist era herdada da categoria, isso significava
  // que nenhum equipamento cadastrado por aqui podia exigir checklist — a causa de só a
  // plataforma marcada como "elevatoria" no banco entrar no fluxo com checklist.
  const [categoria, setCategoria] = useState(plataforma?.categoria ?? "outro");

  // Seção SEGURANÇA — a configuração que define o fluxo da reserva desta plataforma.
  const [exigeChecklist, setExigeChecklist] = useState(plataforma?.exigeChecklist ?? false);
  const [checklistTemplateId, setChecklistTemplateId] = useState<string | null>(
    plataforma?.checklistTemplateId ?? null
  );
  const [templates, setTemplates] = useState<ChecklistTemplateResumo[]>([]);
  const [editorTemplate, setEditorTemplate] = useState<
    { modo: "editar"; id: string } | { modo: "criar" } | null
  >(null);

  // Seção AUTOMAÇÃO — padrões herdados por novas reservas desta plataforma.
  const [inicioAutomaticoPadrao, setInicioAutomaticoPadrao] = useState(
    plataforma?.inicioAutomaticoPadrao ?? false
  );
  const [fimAutomaticoPadrao, setFimAutomaticoPadrao] = useState(plataforma?.fimAutomaticoPadrao ?? false);

  async function carregarTemplates() {
    try {
      setTemplates(await apiFetch<ChecklistTemplateResumo[]>("/api/v1/checklist-modelos"));
    } catch {
      // A lista de templates é auxiliar: falhar aqui não pode impedir a edição dos demais
      // campos do equipamento. O seletor fica vazio e o erro aparece só ao tentar salvar
      // com "exige checklist" marcado sem template.
    }
  }

  useEffect(() => {
    void carregarTemplates();
  }, []);

  const templateSelecionado = templates.find((t) => t.id === checklistTemplateId) ?? null;

  async function handleSelecionarImagem(arquivo: File | undefined) {
    if (!arquivo) return;
    setErro(null);
    if (arquivo.size > TAMANHO_MAX_IMAGEM) {
      setErro("A imagem excede o limite de 10 MB.");
      return;
    }
    const base64 = await lerArquivoComoBase64(arquivo);
    setImagemPreview(base64);
    setImagemBase64(base64);
    setRemoverImagem(false);
  }

  function handleRemoverImagem() {
    setImagemPreview(null);
    setImagemBase64(undefined);
    setRemoverImagem(true);
    if (inputImagemRef.current) inputImagemRef.current.value = "";
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErro(null);

    if (!codigo.trim() || !nome.trim()) {
      setErro("Preencha os campos obrigatórios.");
      return;
    }
    // Mesma regra validada no backend (editarPlataformaSchema): "exige checklist" sem
    // template deixaria a plataforma impossível de aprovar — não há o que preencher.
    if (exigeChecklist && !checklistTemplateId) {
      setErro("Selecione o template de checklist exigido por esta plataforma.");
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
        imagemBase64,
        removerImagem: removerImagem || undefined,
        tipoEquipamento: tipoEquipamento.trim() || undefined,
        alturaMaximaM: alturaMaximaM ? Number(alturaMaximaM) : undefined,
        capacidadeOperadores: capacidadeOperadores ? Number(capacidadeOperadores) : undefined,
        horimetroHoras: horimetroHoras ? Number(horimetroHoras) : undefined,
        categoria,
        exigeChecklist,
        checklistTemplateId: exigeChecklist ? checklistTemplateId : null,
        inicioAutomaticoPadrao,
        fimAutomaticoPadrao,
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
      onClick={aoClicarNoOverlay}
    >
      <div className={`${styles.modal} ${styles.modalLarge}`} ref={refDialogo} {...propsDialogo}>
        <div className={styles.modalHeader}>
          <h3 id={idTitulo}>{plataforma ? "Editar Plataforma" : "Nova Plataforma"}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <form className={styles.modalForm} onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            {erro && (
              <div className={styles.error} role="alert">
                {erro}
              </div>
            )}

            <div className={styles.imageUpload}>
              <input
                ref={inputImagemRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => handleSelecionarImagem(e.target.files?.[0])}
              />
              <div className={styles.imagePreviewBox} onClick={() => inputImagemRef.current?.click()}>
                {imagemPreview ? (
                  <img src={imagemPreview} alt="Pré-visualização" className={styles.imagePreviewImg} />
                ) : (
                  <span className={styles.imagePreviewPlaceholder}>+ Adicionar imagem</span>
                )}
              </div>
              <div className={styles.imageUploadActions}>
                <button type="button" className={styles.btnIcon} onClick={() => inputImagemRef.current?.click()}>
                  {imagemPreview ? "Trocar imagem" : "Selecionar imagem"}
                </button>
                {imagemPreview && (
                  <button type="button" className={styles.btnIconDanger} onClick={handleRemoverImagem}>
                    Remover
                  </button>
                )}
              </div>
            </div>

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
              <div className={styles.formGroup}>
                <label htmlFor="pf-categoria">Categoria</label>
                <select id="pf-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                  {CATEGORIAS.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.rotulo}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-tipo">Tipo de equipamento</label>
                <input
                  id="pf-tipo"
                  value={tipoEquipamento}
                  onChange={(e) => setTipoEquipamento(e.target.value)}
                  placeholder="Ex: Tesoura elétrica"
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-altura">Altura máxima (m)</label>
                <input
                  id="pf-altura"
                  type="number"
                  min="0"
                  step="0.1"
                  value={alturaMaximaM}
                  onChange={(e) => setAlturaMaximaM(e.target.value)}
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-operadores">Operadores (capacidade)</label>
                <input
                  id="pf-operadores"
                  type="number"
                  min="0"
                  value={capacidadeOperadores}
                  onChange={(e) => setCapacidadeOperadores(e.target.value)}
                />
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-horimetro">Horímetro (h)</label>
                <input
                  id="pf-horimetro"
                  type="number"
                  min="0"
                  value={horimetroHoras}
                  onChange={(e) => setHorimetroHoras(e.target.value)}
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

            {/* SEGURANÇA — define se a reserva deste equipamento passa pela etapa de
                checklist antes da aprovação. É esta configuração, e nada mais, que decide
                o fluxo: nenhum equipamento é tratado de forma especial pelo código. */}
            <section className={local.secao}>
              <h4 className={local.secaoTitulo}>Segurança</h4>

              <label className={local.check}>
                <input
                  type="checkbox"
                  checked={exigeChecklist}
                  onChange={(e) => setExigeChecklist(e.target.checked)}
                />
                Exige checklist de segurança antes da aprovação
              </label>
              <p className={local.ajuda}>
                {exigeChecklist
                  ? "Fluxo: Solicitada → Checklist → Aprovada → Em uso → Concluída."
                  : "Fluxo: Solicitada → Aprovada → Em uso → Concluída."}
              </p>

              {exigeChecklist && (
                <div className={local.blocoTemplate}>
                  <div className={styles.formGroup}>
                    <label htmlFor="pf-template">Template de checklist</label>
                    <select
                      id="pf-template"
                      value={checklistTemplateId ?? ""}
                      onChange={(e) => setChecklistTemplateId(e.target.value || null)}
                    >
                      <option value="">Selecione um template…</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.nome} ({t.totalQuestoes}{" "}
                          {t.totalQuestoes === 1 ? "questão" : "questões"})
                        </option>
                      ))}
                    </select>
                  </div>

                  {templateSelecionado && (
                    <p className={local.templateResumo}>
                      {templateSelecionado.nome} · {templateSelecionado.totalQuestoes}{" "}
                      {templateSelecionado.totalQuestoes === 1 ? "questão" : "questões"}
                    </p>
                  )}

                  {/* Atalhos para o MESMO editor usado na área de Checklists — sem sair
                      desta tela, sem navegar para outra página e voltar. */}
                  <div className={local.templateAcoes}>
                    {checklistTemplateId && (
                      <button
                        type="button"
                        className={styles.btnIcon}
                        onClick={() => setEditorTemplate({ modo: "editar", id: checklistTemplateId })}
                      >
                        Editar template
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.btnIcon}
                      onClick={() => setEditorTemplate({ modo: "criar" })}
                    >
                      + Criar novo template
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* AUTOMAÇÃO — padrão herdado por novas reservas. A reserva pode sobrescrever, e
                quem executa a transição é o worker do backend, não o navegador. */}
            <section className={local.secao}>
              <h4 className={local.secaoTitulo}>Automação</h4>
              <label className={local.check}>
                <input
                  type="checkbox"
                  checked={inicioAutomaticoPadrao}
                  onChange={(e) => setInicioAutomaticoPadrao(e.target.checked)}
                />
                Iniciar automaticamente no horário agendado
              </label>
              <label className={local.check}>
                <input
                  type="checkbox"
                  checked={fimAutomaticoPadrao}
                  onChange={(e) => setFimAutomaticoPadrao(e.target.checked)}
                />
                Finalizar automaticamente no horário final
              </label>
              <p className={local.ajuda}>
                Padrão sugerido nas novas reservas deste equipamento — cada reserva pode
                alterar. O início/fim manual continua disponível.
              </p>
            </section>
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

      {editorTemplate && (
        <ChecklistTemplatesModal
          templateIdInicial={editorTemplate.modo === "editar" ? editorTemplate.id : undefined}
          iniciarCriando={editorTemplate.modo === "criar"}
          onClose={() => {
            setEditorTemplate(null);
            void carregarTemplates();
          }}
          onAlterado={() => void carregarTemplates()}
          // Fechar o editor já com o template associado ao equipamento: o Admin criou o
          // template porque nenhum servia, então associá-lo é sempre o próximo passo.
          onSelecionarTemplate={(template) => {
            setChecklistTemplateId(template.id);
            setEditorTemplate(null);
            void carregarTemplates();
          }}
        />
      )}
    </div>
  );
}
