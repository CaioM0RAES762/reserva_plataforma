"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, RefreshCw, Star, X } from "lucide-react";
import styles from "../app/(app)/plataformas/page.module.css";
import local from "./PlataformaModal.module.css";
import { apiFetch, mensagemDeErro } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import {
  LIMITE_IMAGENS,
  MENSAGEM_LIMITE_IMAGENS,
  TIPOS_IMAGEM_ACEITOS,
  moverParaPrincipal,
  triarArquivos,
} from "../lib/galeria";
import { ImagemLightbox } from "./ImagemLightbox";
import type { CategoriaEquipamento } from "./CategoriasEquipamentoSecao";
import { MENSAGEM_TELEFONE_INVALIDO, telefoneValido } from "@plataformares/shared";

export interface PlataformaFormValues {
  codigo: string;
  nome: string;
  localizacao?: string;
  capacidade?: number;
  observacoes?: string;
  status?: "disponivel" | "manutencao" | "inativa";
  tipoEquipamento?: string;
  marca?: string;
  alturaMaximaM?: number;
  capacidadeOperadores?: number;
  horimetroHoras?: number;
  categoria?: string;
  telefoneEmergencia?: string;
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
  /** Setor responsável — enviado só pelo Admin (o Gestor cadastra sempre no próprio setor). */
  setorId?: string;
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
  categoriaNome?: string | null;
  marca?: string | null;
  risco: string;
  imagemUrl: string | null;
  // Galeria (0–4), na ordem de exibição; a primeira é a principal.
  imagens?: ImagemServidor[];
  tipoEquipamento: string | null;
  alturaMaximaM: number | null;
  capacidadeOperadores: number | null;
  horimetroHoras: number | null;
  // Baseline + uso contabilizado (migration 0022). Ausente = só o baseline.
  horimetroAtualHoras?: number | null;
  telefoneEmergencia: string | null;
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
  // Setor responsável (migration 0030); null em plataformas antigas ainda sem atribuição.
  setorId?: string | null;
  setorNome?: string | null;
}

export interface ImagemServidor {
  id: string;
  url: string | null;
  ordem: number;
  principal: boolean;
}

/* Item da galeria no formulário. As mudanças ficam pendentes até "Salvar" (Cancelar
   descarta tudo); ao salvar, cada imagem vira uma requisição própria — uma falha não
   derruba as outras, e o item que já subiu guarda o `id` do servidor, então tentar de
   novo não duplica arquivo. */
interface ItemGaleria {
  chave: string;
  id: string | null;
  url: string | null;
  base64: string | null;
  nomeArquivo: string | null;
  erro: string | null;
}

interface PlataformaSalva {
  id: string;
  imagens: ImagemServidor[];
}

/* Opção de ATALHO no select de Categoria — nunca é um valor de categoria: o onChange a
   intercepta e só navega para Configurações; o estado do formulário não muda. */
const OPCAO_CADASTRAR_CATEGORIA = "__cadastrar_categoria__";
export const LINK_CATEGORIAS_EQUIPAMENTO = "/administracao/configuracoes#categorias-equipamento";

interface PlataformaModalProps {
  plataforma: PlataformaEditavel | null;
  /** Só o Admin gerencia categorias — só ele vê o atalho "+ Cadastrar categoria". */
  podeGerenciarCategorias?: boolean;
  /** Admin escolhe o setor responsável; o Gestor vê o próprio setor, sem escolher. */
  escolheSetor?: boolean;
  /** Setor do Gestor logado (exibido como fixo em cadastro novo). */
  setorFixoNome?: string | null;
  onClose: () => void;
  /** Grava os campos (POST quando `idExistente` é null, PUT caso contrário) e devolve o id. */
  onSalvar: (valores: PlataformaFormValues, idExistente: string | null) => Promise<string>;
  /** Tudo salvo (campos e imagens): fecha e recarrega. */
  onConcluido: () => void;
}

let sequenciaChave = 0;
const novaChave = () => `img-${++sequenciaChave}`;

function lerArquivoComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result as string);
    leitor.onerror = reject;
    leitor.readAsDataURL(arquivo);
  });
}

export function PlataformaModal({
  plataforma,
  podeGerenciarCategorias = false,
  escolheSetor = false,
  setorFixoNome = null,
  onClose,
  onSalvar,
  onConcluido,
}: PlataformaModalProps) {
  const router = useRouter();
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
  const [marca, setMarca] = useState(plataforma?.marca ?? "");
  // Setor responsável (migration 0030). Só o Admin carrega a lista e escolhe.
  const [setorId, setSetorId] = useState(plataforma?.setorId ?? "");
  const [setores, setSetores] = useState<Array<{ id: string; nome: string }> | null>(null);
  useEffect(() => {
    if (!escolheSetor) return;
    apiFetch<Array<{ id: string; nome: string }>>("/api/v1/setores")
      .then(setSetores)
      .catch(() => setSetores([]));
  }, [escolheSetor]);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Galeria. `idSalvo`: depois do 1º salvamento de uma plataforma NOVA, uma nova tentativa
  // (ex.: uma imagem falhou) vira edição — nunca cria a plataforma duas vezes.
  const [idSalvo, setIdSalvo] = useState<string | null>(plataforma?.id ?? null);
  const [itens, setItens] = useState<ItemGaleria[]>(() =>
    (plataforma?.imagens ?? []).map((img) => ({
      chave: novaChave(),
      id: img.id,
      url: img.url,
      base64: null,
      nomeArquivo: null,
      erro: null,
    }))
  );
  const [removidos, setRemovidos] = useState<string[]>([]);
  const [avisoGaleria, setAvisoGaleria] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const inputAdicionarRef = useRef<HTMLInputElement>(null);
  const inputSubstituirRef = useRef<HTMLInputElement>(null);
  const substituindoChave = useRef<string | null>(null);

  // Categorias administráveis (Configurações). Ativas + a atual da plataforma, mesmo que
  // desativada depois — uma plataforma antiga nunca "perde" a categoria no formulário.
  const [categorias, setCategorias] = useState<CategoriaEquipamento[] | null>(null);
  useEffect(() => {
    let cancelado = false;
    apiFetch<CategoriaEquipamento[]>("/api/v1/categorias-equipamento")
      .then((lista) => {
        if (!cancelado) setCategorias(lista);
      })
      .catch(() => {
        if (!cancelado) setCategorias([]);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  // Categorias vêm só do backend (Configurações → Categorias de equipamento). Nova
  // plataforma começa sem valor e assume a primeira categoria ativa assim que a lista chega.
  const [categoria, setCategoria] = useState(plataforma?.categoria ?? "");
  const opcoesCategoria = (categorias ?? []).filter((c) => c.ativo || c.codigo === plataforma?.categoria);
  useEffect(() => {
    if (plataforma || !categorias || categorias.length === 0) return;
    if (!categorias.some((c) => c.ativo && c.codigo === categoria)) {
      const primeira = categorias.find((c) => c.ativo);
      if (primeira) setCategoria(primeira.codigo);
    }
  }, [categorias, categoria, plataforma]);

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

  function descreverRecusas(recusados: Array<{ nome: string; motivo: string }>, excedeuLimite: boolean) {
    const frases: string[] = [];
    if (recusados.length > 0) {
      frases.push(`Não adicionada: ${recusados.map((r) => `${r.nome} (${r.motivo})`).join("; ")}.`);
    }
    if (excedeuLimite) frases.push(MENSAGEM_LIMITE_IMAGENS);
    return frases.length > 0 ? frases.join(" ") : null;
  }

  async function handleAdicionarImagens(lista: FileList | null) {
    const arquivos = Array.from(lista ?? []);
    if (inputAdicionarRef.current) inputAdicionarRef.current.value = "";
    if (arquivos.length === 0) return;
    const { aceitos, recusados, excedeuLimite } = triarArquivos(arquivos, itens.length);
    const novos = await Promise.all(
      aceitos.map(async (arquivo) => {
        const base64 = await lerArquivoComoBase64(arquivo);
        return { chave: novaChave(), id: null, url: base64, base64, nomeArquivo: arquivo.name, erro: null };
      })
    );
    setItens((atuais) => [...atuais, ...novos].slice(0, LIMITE_IMAGENS));
    setAvisoGaleria(
      descreverRecusas(recusados, excedeuLimite)
    );
  }

  async function handleSubstituirImagem(lista: FileList | null) {
    const chave = substituindoChave.current;
    substituindoChave.current = null;
    const arquivo = lista?.[0];
    if (inputSubstituirRef.current) inputSubstituirRef.current.value = "";
    if (!arquivo || !chave) return;
    // Substituição não ocupa vaga nova: triagem só de tipo/tamanho.
    const { aceitos, recusados } = triarArquivos([arquivo], 0);
    if (aceitos.length === 0) {
      setAvisoGaleria(descreverRecusas(recusados, false));
      return;
    }
    const base64 = await lerArquivoComoBase64(arquivo);
    setAvisoGaleria(null);
    setItens((atuais) =>
      atuais.map((item) =>
        item.chave === chave ? { ...item, url: base64, base64, nomeArquivo: arquivo.name, erro: null } : item
      )
    );
  }

  function handleRemoverItem(chave: string) {
    const item = itens.find((i) => i.chave === chave);
    if (!item) return;
    if (item.id) setRemovidos((atuais) => [...atuais, item.id!]);
    setItens((atuais) => atuais.filter((i) => i.chave !== chave));
    setAvisoGaleria(null);
  }

  function handleTornarPrincipal(chave: string) {
    setItens((atuais) => moverParaPrincipal(atuais, atuais.findIndex((i) => i.chave === chave)));
  }

  /* Aplica a galeria no servidor, uma operação por vez: remoções → substituições/novas (na
     ordem da tela) → principal. Devolve as falhas; o que deu certo fica salvo e marcado. */
  async function sincronizarImagens(plataformaId: string): Promise<string[]> {
    const falhas: string[] = [];
    const base = `/api/v1/plataformas/${plataformaId}/imagens`;
    let servidor: ImagemServidor[] | null = null;

    const removidosOk: string[] = [];
    for (const id of removidos) {
      try {
        servidor = (await apiFetch<PlataformaSalva>(`${base}/${id}`, { method: "DELETE" })).imagens;
        removidosOk.push(id);
      } catch (err) {
        falhas.push(`remoção de imagem (${mensagemDeErro(err, "erro")})`);
      }
    }
    setRemovidos((atuais) => atuais.filter((id) => !removidosOk.includes(id)));

    const resultado = [...itens];
    for (let i = 0; i < resultado.length; i++) {
      const item = resultado[i];
      if (!item.base64) continue;
      try {
        const corpo = JSON.stringify({ imagemBase64: item.base64 });
        if (item.id) {
          servidor = (await apiFetch<PlataformaSalva>(`${base}/${item.id}`, { method: "PUT", body: corpo })).imagens;
          resultado[i] = { ...item, base64: null, erro: null };
        } else {
          // Ids que JÁ existiam no servidor — a imagem nova é a que não está aqui.
          const idsAntes = new Set([
            ...(servidor ?? plataforma?.imagens ?? []).map((img) => img.id),
            ...resultado.flatMap((r) => (r.id ? [r.id] : [])),
            ...removidos,
          ]);
          servidor = (await apiFetch<PlataformaSalva>(base, { method: "POST", body: corpo })).imagens;
          const criada = servidor.find((img) => !idsAntes.has(img.id));
          resultado[i] = { ...item, id: criada?.id ?? null, base64: null, erro: null };
        }
      } catch (err) {
        const motivo = mensagemDeErro(err, "erro no envio");
        resultado[i] = { ...item, erro: motivo };
        falhas.push(`${item.nomeArquivo ?? "imagem"} (${motivo})`);
      }
    }

    // Principal = primeira da tela, se ela já existe no servidor.
    const desejada = resultado.find((item) => item.id)?.id ?? null;
    const principalAtual =
      (servidor ?? (plataforma?.imagens ?? []).filter((img) => !removidosOk.includes(img.id))).find((img) => img.principal)
        ?.id ?? null;
    if (desejada && resultado[0]?.id === desejada && desejada !== principalAtual) {
      try {
        await apiFetch(`${base}/${desejada}/principal`, { method: "PATCH" });
      } catch (err) {
        falhas.push(`imagem principal (${mensagemDeErro(err, "erro")})`);
      }
    }

    setItens(resultado);
    return falhas;
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
    if (!categoria) {
      setErro("Selecione a categoria.");
      return;
    }
    if (escolheSetor && !setorId) {
      setErro("Selecione o setor responsável pela plataforma.");
      return;
    }

    setSalvando(true);
    try {
      const id = await onSalvar(
        {
        codigo: codigo.trim(),
        nome: nome.trim(),
        localizacao: localizacao.trim() || undefined,
        capacidade: capacidade ? Number(capacidade) : undefined,
        observacoes: observacoes.trim() || undefined,
        status: plataforma ? (status as PlataformaFormValues["status"]) : undefined,
        tipoEquipamento: tipoEquipamento.trim() || undefined,
        marca: marca.trim() || undefined,
        alturaMaximaM: alturaMaximaM ? Number(alturaMaximaM) : undefined,
        capacidadeOperadores: capacidadeOperadores ? Number(capacidadeOperadores) : undefined,
        horimetroHoras:
          horimetroHoras && (!plataforma || horimetroHoras !== horimetroInicial) ? Number(horimetroHoras) : undefined,
        categoria,
        telefoneEmergencia: telefoneEmergencia.trim() || undefined,
        inicioAutomaticoPadrao,
        fimAutomaticoPadrao,
        ...(escolheSetor ? { setorId } : {}),
        },
        idSalvo
      );
      setIdSalvo(id);
      const falhas = await sincronizarImagens(id);
      if (falhas.length > 0) {
        setErro(
          `Plataforma salva, mas ${falhas.length === 1 ? "uma operação de imagem falhou" : `${falhas.length} operações de imagem falharam`}: ${falhas.join("; ")}. As demais foram salvas — salve novamente para tentar de novo.`
        );
        return;
      }
      onConcluido();
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
          <h3 id={idTitulo}>{idSalvo ? "Editar Plataforma" : "Nova Plataforma"}</h3>
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

            <div className={styles.galeria}>
              <div className={styles.galeriaCabecalho}>
                <span className={styles.galeriaTitulo} id="pf-imagens-titulo">
                  Imagens
                </span>
                <span className={styles.galeriaSub}>Até {LIMITE_IMAGENS} fotos · JPG, PNG ou WEBP</span>
              </div>
              <input
                ref={inputAdicionarRef}
                type="file"
                accept={TIPOS_IMAGEM_ACEITOS.join(",")}
                multiple
                hidden
                onChange={(e) => handleAdicionarImagens(e.target.files)}
              />
              <input
                ref={inputSubstituirRef}
                type="file"
                accept={TIPOS_IMAGEM_ACEITOS.join(",")}
                hidden
                onChange={(e) => handleSubstituirImagem(e.target.files)}
              />
              <ul className={styles.galeriaLista} aria-labelledby="pf-imagens-titulo">
                {itens.map((item, indice) => (
                  <li
                    key={item.chave}
                    className={`${styles.galeriaItem} ${indice === 0 ? styles.galeriaItemPrincipal : ""} ${
                      item.erro ? styles.galeriaItemErro : ""
                    }`}
                    title={item.erro ?? undefined}
                  >
                    {item.url ? (
                      <button
                        type="button"
                        className={styles.galeriaMiniatura}
                        onClick={() => setLightbox(itens.filter((i) => i.url).findIndex((i) => i.chave === item.chave))}
                        aria-label={`Ver imagem ${indice + 1}${indice === 0 ? " (principal)" : ""}`}
                      >
                        <img src={item.url} alt="" />
                      </button>
                    ) : (
                      <span className={styles.imagePreviewPlaceholder}>Sem prévia</span>
                    )}
                    <span className={styles.galeriaAcoes}>
                      {indice > 0 && (
                        <button
                          type="button"
                          className={styles.galeriaAcao}
                          onClick={() => handleTornarPrincipal(item.chave)}
                          aria-label={`Tornar a imagem ${indice + 1} principal`}
                          title="Tornar principal"
                        >
                          <Star size={13} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.galeriaAcao}
                        onClick={() => {
                          substituindoChave.current = item.chave;
                          inputSubstituirRef.current?.click();
                        }}
                        aria-label={`Substituir a imagem ${indice + 1}`}
                        title="Substituir"
                      >
                        <RefreshCw size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={`${styles.galeriaAcao} ${styles.galeriaAcaoPerigo}`}
                        onClick={() => handleRemoverItem(item.chave)}
                        aria-label={`Remover a imagem ${indice + 1}`}
                        title="Remover"
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </span>
                    {indice === 0 ? (
                      <span className={styles.galeriaSelo}>Principal</span>
                    ) : item.base64 ? (
                      <span className={`${styles.galeriaSelo} ${styles.galeriaSeloNova}`}>Nova</span>
                    ) : null}
                  </li>
                ))}
                {itens.length < LIMITE_IMAGENS && (
                  <li>
                    <button
                      type="button"
                      className={styles.galeriaAdicionar}
                      onClick={() => inputAdicionarRef.current?.click()}
                    >
                      <ImagePlus size={18} aria-hidden="true" />
                      Adicionar
                    </button>
                  </li>
                )}
              </ul>
              {avisoGaleria ? (
                <p className={`${styles.galeriaNota} ${styles.galeriaNotaErro}`} role="status">
                  {avisoGaleria}
                </p>
              ) : itens.length >= LIMITE_IMAGENS ? (
                <p className={styles.galeriaNota} role="status">
                  {MENSAGEM_LIMITE_IMAGENS}
                </p>
              ) : itens.length > 1 || removidos.length > 0 ? (
                <p className={styles.galeriaNota}>
                  A primeira é a capa do card. As mudanças nas imagens são aplicadas ao salvar.
                </p>
              ) : null}
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
                <label htmlFor="pf-setor">Setor responsável{escolheSetor ? " *" : ""}</label>
                {escolheSetor ? (
                  <select
                    id="pf-setor"
                    value={setorId}
                    onChange={(e) => setSetorId(e.target.value)}
                    aria-required="true"
                    data-testid="plataforma-setor"
                  >
                    <option value="">{setores === null ? "Carregando..." : "Selecione o setor"}</option>
                    {/* Setor atual inativo continua visível para não "sumir" do formulário. */}
                    {plataforma?.setorId && setores !== null && !setores.some((s) => s.id === plataforma.setorId) && (
                      <option value={plataforma.setorId}>{plataforma.setorNome ?? "Setor atual"}</option>
                    )}
                    {(setores ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nome}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="pf-setor"
                    value={plataforma ? (plataforma.setorNome ?? "Sem setor definido") : (setorFixoNome ?? "Seu setor")}
                    readOnly
                    aria-readonly="true"
                  />
                )}
                {!escolheSetor && !plataforma && (
                  <span className={styles.formHint}>Plataformas cadastradas por gestores ficam no setor do gestor.</span>
                )}
              </div>
              <div className={styles.formGroup}>
                <label htmlFor="pf-categoria">Categoria *</label>
                <select
                  id="pf-categoria"
                  value={categoria}
                  onChange={(e) => {
                    // Atalho, não valor: navega e mantém a categoria atual intacta.
                    if (e.target.value === OPCAO_CADASTRAR_CATEGORIA) {
                      router.push(LINK_CATEGORIAS_EQUIPAMENTO);
                      return;
                    }
                    setCategoria(e.target.value);
                  }}
                  disabled={categorias === null}
                  aria-required="true"
                >
                  {categorias === null && <option value={categoria}>{plataforma?.categoriaNome ?? "Carregando..."}</option>}
                  {categorias !== null && categoria === "" && (
                    <option value="" disabled>
                      {opcoesCategoria.length === 0 ? "Nenhuma categoria cadastrada" : "Selecione a categoria"}
                    </option>
                  )}
                  {categorias !== null &&
                    categoria !== "" &&
                    !opcoesCategoria.some((c) => c.codigo === categoria) && (
                      <option value={categoria}>{plataforma?.categoriaNome ?? categoria}</option>
                    )}
                  {opcoesCategoria.map((c) => (
                    <option key={c.codigo} value={c.codigo}>
                      {c.ativo ? c.nome : `${c.nome} (inativa)`}
                    </option>
                  ))}
                  {categorias !== null && podeGerenciarCategorias && (
                    <>
                      <option disabled value="__separador__">
                        ──────────────
                      </option>
                      <option value={OPCAO_CADASTRAR_CATEGORIA}>+ Cadastrar categoria</option>
                    </>
                  )}
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
                <label htmlFor="pf-marca">Marca</label>
                <input
                  id="pf-marca"
                  value={marca}
                  onChange={(e) => setMarca(e.target.value)}
                  maxLength={60}
                  placeholder="Ex: Dingli, JLG, Genie"
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
              {salvando ? "Salvando..." : idSalvo ? "Salvar Alterações" : "Salvar"}
            </button>
          </div>
        </form>
      </div>

      {lightbox !== null && (
        <ImagemLightbox
          imagens={itens.filter((i) => i.url).map((i) => ({ url: i.url! }))}
          indiceInicial={lightbox}
          titulo={nome || "Plataforma"}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
