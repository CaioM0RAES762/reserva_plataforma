"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "../app/(app)/plataformas/page.module.css";
import local from "./PlataformaModal.module.css";
import { apiFetch } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { MENSAGEM_TELEFONE_INVALIDO, telefoneValido } from "@plataformares/shared";

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
  telefoneEmergencia?: string;
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
  // Baseline + uso contabilizado (migration 0022). Ausente = só o baseline.
  horimetroAtualHoras?: number | null;
  telefoneEmergencia: string | null;
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
  // Na edição o campo mostra o horímetro ATUAL (baseline + uso) em horas inteiras e só é
  // enviado se o Admin mudar o valor — reenviar o formulário nunca sobrescreve o uso
  // acumulado. Mudança = correção explícita, auditada no backend (corrigir_horimetro).
  const horimetroInicial = (() => {
    const atual = plataforma?.horimetroAtualHoras ?? plataforma?.horimetroHoras ?? null;
    return atual === null ? "" : String(Math.floor(atual));
  })();
  const [horimetroHoras, setHorimetroHoras] = useState(horimetroInicial);
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

  // Contato acionado quando algo dá errado COM O EQUIPAMENTO durante o uso.
  const [telefoneEmergencia, setTelefoneEmergencia] = useState(plataforma?.telefoneEmergencia ?? "");

  // Seção AUTOMAÇÃO — padrões herdados por novas reservas desta plataforma. Nascem
  // ligados: iniciar/concluir por horário é o comportamento normal do fluxo.
  const [inicioAutomaticoPadrao, setInicioAutomaticoPadrao] = useState(
    plataforma?.inicioAutomaticoPadrao ?? true
  );
  const [fimAutomaticoPadrao, setFimAutomaticoPadrao] = useState(plataforma?.fimAutomaticoPadrao ?? true);

  // Mesmo validador do schema no backend — o formulário não pode aceitar o que a API
  // rejeita. Vazio é válido: nem todo ativo tem uma linha própria.
  const erroTelefone =
    telefoneEmergencia.trim() !== "" && !telefoneValido(telefoneEmergencia)
      ? MENSAGEM_TELEFONE_INVALIDO
      : null;

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
    if (erroTelefone) {
      setErro(erroTelefone);
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
        horimetroHoras:
          horimetroHoras && (!plataforma || horimetroHoras !== horimetroInicial) ? Number(horimetroHoras) : undefined,
        categoria,
        telefoneEmergencia: telefoneEmergencia.trim() || undefined,
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
                <label htmlFor="pf-telefone">Telefone para emergência</label>
                {/* type="tel", nunca "number": o valor carrega DDD entre parênteses,
                    hífen, +55 e às vezes ramal — "number" descartaria a formatação e
                    ainda comeria o zero à esquerda do DDD. */}
                <input
                  id="pf-telefone"
                  type="tel"
                  inputMode="tel"
                  maxLength={40}
                  value={telefoneEmergencia}
                  onChange={(e) => setTelefoneEmergencia(e.target.value)}
                  placeholder="(31) 3333-0000"
                  aria-invalid={erroTelefone ? true : undefined}
                  aria-describedby={erroTelefone ? "pf-telefone-erro" : undefined}
                />
                {erroTelefone && (
                  <span id="pf-telefone-erro" className={styles.fieldError} role="alert">
                    {erroTelefone}
                  </span>
                )}
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
                <label htmlFor="pf-horimetro">{plataforma ? "Horímetro atual (h)" : "Horímetro inicial (h)"}</label>
                <input
                  id="pf-horimetro"
                  type="number"
                  min="0"
                  value={horimetroHoras}
                  onChange={(e) => setHorimetroHoras(e.target.value)}
                  aria-describedby="pf-horimetro-ajuda"
                />
                <p id="pf-horimetro-ajuda" className={local.ajuda}>
                  {plataforma
                    ? "Atualizado automaticamente pelo uso das reservas concluídas. Alterar o valor registra uma correção na auditoria."
                    : "Valor atual do equipamento. A partir daqui, o uso das reservas é somado automaticamente."}
                </p>
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

            {/* A seção "Segurança" (exige checklist / template) foi REMOVIDA: o checklist
                deixou de ser etapa da reserva, então a configuração não decidia mais nada.
                As execuções NR-18/35 já realizadas continuam no histórico, e as normas do
                equipamento seguem derivadas de categoria/altura na Frota. */}

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

    </div>
  );
}
