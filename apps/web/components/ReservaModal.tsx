"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  CODIGO_ERRO_HORARIO_INDISPONIVEL,
  EMPRESA_TERCEIRIZADA_MAX,
  ULTIMO_MINUTO_RESERVAVEL,
  formatarTelefone,
  horaParaMinutos,
  MENSAGEM_TELEFONE_INVALIDO,
  minutosParaHora,
  normalizarEmpresaTerceirizada,
  setorExigeEmpresaTerceirizada,
  telefoneValido,
  validarEmpresaTerceirizada,
  type ProximoHorarioResposta,
} from "@plataformares/shared";
import styles from "./ReservaModal.module.css";
import { apiFetch, ApiRequestError, mensagemDeErro } from "../lib/api";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import { invalidarDisponibilidade, useDisponibilidade } from "../lib/useDisponibilidade";
import { SeletorHorario } from "./SeletorHorario";
import {
  calcularAgendaPlataforma,
  dataIsoValida,
  fimDaSelecao,
  hojeBrasilia,
  opcoesFimPersonalizado,
  selecaoDeIntervalo,
  selecaoPadrao,
  selecaoValida,
  somarDias,
  type PrioridadeReserva,
  type SelecaoHorario,
} from "./SeletorHorarioCalculos";

export interface ReservaFormValues {
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  quantidadePessoas: number;
  /* Snapshot: fica gravado NA RESERVA, não é uma referência ao cadastro do usuário. Se o
     telefone da pessoa mudar depois, a reserva antiga continua mostrando o contato que
     valia no momento em que foi criada. */
  telefoneContato: string;
  motivo: string;
  prioridade: PrioridadeReserva;
  recorrencia?: { quantidadeOcorrencias: number };
  inicioAutomatico: boolean;
  fimAutomatico: boolean;
  // S14 (RF-RES-01): só preenchido quando quem solicita é Admin (sem setor_id próprio,
  // RN-USR-01) — ver seletor de "Setor solicitante" mais abaixo.
  setorId?: string;
  /* Só enviado quando o setor da reserva é "Terceirizados" (setorExigeEmpresaTerceirizada);
     já normalizado (trim + espaços colapsados). Omitido em setores internos — o backend
     trata ausência como "não informado" e revalida a obrigatoriedade. */
  empresaTerceirizada?: string;
}

interface PlataformaOpcao {
  id: string;
  codigo: string;
  nome: string;
  status: string;
  // null = capacidade ainda não cadastrada para esta plataforma (não confundir com 0).
  // `capacidade` é a capacidade de CARGA em kg; `capacidadeOperadores` é a capacidade de
  // PESSOAS/operadores — dois campos distintos no banco (Plataforma.capacidade vs
  // Plataforma.capacidade_operadores). Nunca usar um no lugar do outro.
  capacidade: number | null;
  capacidadeOperadores: number | null;
  // Padrões de automação do equipamento — pré-selecionam as opções abaixo quando a
  // plataforma é escolhida. A decisão final é a gravada nesta reserva.
  inicioAutomaticoPadrao: boolean;
  fimAutomaticoPadrao: boolean;
  telefoneEmergencia: string | null;
}

interface SetorOpcao {
  id: string;
  nome: string;
}

// RF-RES-13 ("Reservar novamente"): pré-preenche plataforma/motivo/prioridade de uma
// reserva concluída/cancelada — deliberadamente SEM data/horário/status, que o usuário
// deve escolher de novo (a data antiga quase sempre já passou).
const PRIORIDADES: Array<{ valor: PrioridadeReserva; rotulo: string }> = [
  { valor: "normal", rotulo: "Normal" },
  { valor: "alta", rotulo: "Alta" },
  { valor: "urgente", rotulo: "Urgente" },
];

export interface ReservaValoresIniciais {
  plataformaId: string;
  motivo: string;
  prioridade: PrioridadeReserva;
  // Preenchidos ao criar a partir de um clique num horário vazio do Calendário — nunca
  // presentes no fluxo "Reservar novamente" (RF-RES-13), que deliberadamente não herda data/hora.
  data?: string;
  horaInicio?: string;
  horaFim?: string;
}

interface ReservaModalProps {
  usuarioId: string;
  solicitanteNome: string;
  setorNome: string | null;
  /** Telefone cadastrado no perfil do usuário logado (GET /conta) — preenche o contato
   *  automaticamente; ausente para contas anteriores à migration 0021 (fallback abaixo). */
  telefonePerfil?: string | null;
  onClose: () => void;
  onSalvar: (valores: ReservaFormValues) => Promise<void>;
  valoresIniciais?: ReservaValoresIniciais;
}

// Quantos dias à frente "Ver próximo horário disponível" procura (máximo aceito pela API: 30).
const LIMITE_DIAS_PROXIMO = 14;
const MENSAGEM_HORARIO_INDISPONIVEL = "Esse horário acabou de ficar indisponível.";
// Mesmos `tipo` que a API devolve no 409 de conflito/bloqueio (services/disponibilidade.service.ts).
const TIPOS_CONFLITO_HORARIO = ["conflito_reserva", "bloqueio_global", "bloqueio_plataforma"];

// ---------------------------------------------------------------------------------------
// Contato: último telefone informado NESTE navegador
// ---------------------------------------------------------------------------------------
// O cadastro do usuário não tem telefone e a reserva exige um (snapshot). Para não pedir o
// mesmo número a cada reserva, guardamos só o último que a própria pessoa informou, por
// nome do solicitante, neste navegador — nunca inventado nem vindo do servidor. localStorage
// pode lançar (janela privada, dados bloqueados): tudo em try/catch e o formulário funciona
// sem ele.
function chaveTelefone(solicitanteNome: string): string {
  return `plataformares:reserva:telefone:${solicitanteNome}`;
}

function lerTelefoneSalvo(solicitanteNome: string): string {
  try {
    const valor = window.localStorage.getItem(chaveTelefone(solicitanteNome));
    // Mesma validação do envio: um valor antigo/corrompido não vira pré-preenchimento.
    return valor && telefoneValido(valor) ? valor : "";
  } catch {
    return "";
  }
}

function salvarTelefone(solicitanteNome: string, telefone: string): void {
  try {
    window.localStorage.setItem(chaveTelefone(solicitanteNome), telefone);
  } catch {
    // Sem armazenamento: só perde o pré-preenchimento da próxima vez.
  }
}

// ---------------------------------------------------------------------------------------
// Leitura de erros da API
// ---------------------------------------------------------------------------------------

/** 409 de horário: código estável do contrato novo, ou o `tipo` que o serviço de conflito já enviava. */
function ehHorarioIndisponivel(err: unknown): err is ApiRequestError {
  if (!(err instanceof ApiRequestError) || err.status !== 409) return false;
  const codigo = err.codigo ?? err.corpo?.codigo;
  const tipo = err.corpo?.tipo;
  return (
    codigo === CODIGO_ERRO_HORARIO_INDISPONIVEL || (typeof tipo === "string" && TIPOS_CONFLITO_HORARIO.includes(tipo))
  );
}

interface ErrosDeValidacao {
  campos: Record<string, string[]>;
  gerais: string[];
}

/** `detalhes` de um 422 é o `flatten()` do zod: { formErrors, fieldErrors }. */
function lerErrosDeValidacao(detalhes: unknown): ErrosDeValidacao {
  const resultado: ErrosDeValidacao = { campos: {}, gerais: [] };
  if (!detalhes || typeof detalhes !== "object") return resultado;
  const { fieldErrors, formErrors } = detalhes as {
    fieldErrors?: Record<string, string[] | undefined>;
    formErrors?: string[];
  };
  for (const [campo, mensagens] of Object.entries(fieldErrors ?? {})) {
    if (mensagens && mensagens.length > 0) resultado.campos[campo] = mensagens;
  }
  resultado.gerais = formErrors ?? [];
  return resultado;
}

function rotuloPlataforma(p: PlataformaOpcao): string {
  const base = `${p.codigo} · ${p.nome}`;
  if (p.status === "manutencao") return `${base} (em manutenção)`;
  if (p.status === "inativa") return `${base} (inativa)`;
  return base;
}

function descreverIndisponibilidade(status: string | undefined): string | null {
  if (status === "manutencao") return "em manutenção";
  if (status === "inativa") return "inativa";
  return null;
}

/** "HH:mm" -> minutos, ou null se malformado (valores iniciais vêm de fora do modal). */
function minutosSeguros(hhmm: string | undefined): number | null {
  return hhmm && /^\d{2}:\d{2}$/.test(hhmm) ? horaParaMinutos(hhmm) : null;
}

interface IntervaloCalendario {
  data: string;
  inicioMin: number;
  fimMin: number;
}

function lerIntervaloCalendario(valores: ReservaValoresIniciais | undefined): IntervaloCalendario | null {
  const inicioMin = minutosSeguros(valores?.horaInicio);
  const fimBruto = minutosSeguros(valores?.horaFim);
  if (!valores?.data || inicioMin === null || fimBruto === null) return null;
  // "24:00" (fim de grade do calendário) não é um HH:mm reservável — corta em 23:59.
  const fimMin = Math.min(fimBruto, ULTIMO_MINUTO_RESERVAVEL);
  return fimMin > inicioMin ? { data: valores.data, inicioMin, fimMin } : null;
}

export function ReservaModal({
  usuarioId,
  solicitanteNome,
  setorNome,
  telefonePerfil,
  onClose,
  onSalvar,
  valoresIniciais,
}: ReservaModalProps) {
  // Relógio do modal: alimenta "hoje" (vira à meia-noite com o modal aberto) e a antecedência
  // mínima, que anda junto com o relógio. Meio minuto basta — os chips são de 30 min.
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setAgoraMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const hoje = hojeBrasilia(new Date(agoraMs));
  const amanha = somarDias(hoje, 1);

  const [plataformas, setPlataformas] = useState<PlataformaOpcao[]>([]);
  const [erroPlataformas, setErroPlataformas] = useState<string | null>(null);
  const [plataformaId, setPlataformaId] = useState(valoresIniciais?.plataformaId ?? "");
  const [prioridade, setPrioridade] = useState<PrioridadeReserva>(valoresIniciais?.prioridade ?? "normal");
  const [data, setData] = useState(() => valoresIniciais?.data ?? hojeBrasilia());
  const [selecao, setSelecao] = useState<SelecaoHorario | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Intervalo que veio do clique/arraste no Calendário. Fica guardado (não aplicado de uma
  // vez) porque o calendário abre o modal SEM plataforma: o intervalo só pode ser validado
  // depois que a plataforma é escolhida — e continua valendo se ela for trocada, até o
  // usuário escolher outro horário ou outra data.
  const intervaloCalendarioRef = useRef<IntervaloCalendario | null>(null);
  const [intervaloCalendarioInicial] = useState(() => lerIntervaloCalendario(valoresIniciais));
  useEffect(() => {
    // Só na montagem: depois disso o ref é mexido pelos handlers (troca de data/horário).
    intervaloCalendarioRef.current = intervaloCalendarioInicial;
  }, [intervaloCalendarioInicial]);

  // String (não number) para o campo poder ficar vazio enquanto o usuário apaga e
  // redigita, sem o React forçar de volta para "1" a cada tecla.
  const [quantidadePessoas, setQuantidadePessoas] = useState("1");
  // Preferência: telefone do perfil (servidor, por usuário autenticado) — cai para o último
  // informado neste navegador só quando o perfil não tem o dado (contas anteriores à
  // migration 0021). Mesma validação de sempre: um valor inválido não vira pré-preenchimento.
  const [telefoneSalvo] = useState(() =>
    telefonePerfil && telefoneValido(telefonePerfil) ? telefonePerfil : lerTelefoneSalvo(solicitanteNome)
  );
  const [telefoneContato, setTelefoneContato] = useState(telefoneSalvo);
  const [alterandoTelefone, setAlterandoTelefone] = useState(false);
  const [telefoneTocado, setTelefoneTocado] = useState(false);
  const [motivo, setMotivo] = useState(valoresIniciais?.motivo ?? "");
  const [motivoTocado, setMotivoTocado] = useState(false);
  const [tentouEnviar, setTentouEnviar] = useState(false);

  const [erro, setErro] = useState<string | null>(null);
  const [erroConflito, setErroConflito] = useState<{ titulo: string; detalhe: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [opcoesAbertas, setOpcoesAbertas] = useState(false);
  const [repetirSemanalmente, setRepetirSemanalmente] = useState(false);
  // String pelo mesmo motivo da quantidade: um clamp a cada tecla impedia digitar "10".
  const [ocorrenciasTexto, setOcorrenciasTexto] = useState("4");
  // Automação: nasce com o padrão da plataforma escolhida e pode ser sobrescrita aqui. O
  // valor final fica gravado NA RESERVA — quem executa a transição no horário é o worker
  // do backend, nunca um timer no navegador.
  // Ligadas por padrão: uma reserva nova normalmente inicia e termina sozinha. Ao escolher a
  // plataforma, o padrão persistido NELA (inicio/fim_automatico_padrao) passa a valer.
  const [inicioAutomatico, setInicioAutomatico] = useState(true);
  const [fimAutomatico, setFimAutomatico] = useState(true);
  const [automacaoTocada, setAutomacaoTocada] = useState(false);

  // S14 (RF-RES-01): Admin não tem setor_id de sessão (RN-USR-01) — precisa escolher o
  // setor de destino da reserva. `setorNome === null` é como o resto do app já identifica
  // "sou Admin" nesta tela (ver Sidebar/Topbar).
  const exigeSelecaoDeSetor = setorNome === null;
  const [setores, setSetores] = useState<SetorOpcao[]>([]);
  const [setorSelecionadoId, setSetorSelecionadoId] = useState("");

  const [empresa, setEmpresa] = useState("");
  const [empresaTocada, setEmpresaTocada] = useState(false);
  const [erroEmpresaServidor, setErroEmpresaServidor] = useState<string | null>(null);

  const [procurandoProximo, setProcurandoProximo] = useState(false);
  const [mensagemProximo, setMensagemProximo] = useState<string | null>(null);
  const sequenciaProximo = useRef(0);

  const refEmpresa = useRef<HTMLInputElement | null>(null);
  const refTelefone = useRef<HTMLInputElement | null>(null);
  const idOpcoes = useId();

  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "reserva-modal");

  // ---------------------------------------------------------------------------------------
  // Carga de dados
  // ---------------------------------------------------------------------------------------

  const carregarPlataformas = useCallback(() => {
    setErroPlataformas(null);
    apiFetch<PlataformaOpcao[]>("/api/v1/plataformas")
      .then((lista) => {
        // Ordenadas por código (numérico-aware: PLT-2 antes de PLT-10). Manutenção/inativa
        // continuam na lista, desabilitadas e com o motivo no rótulo: sumir com elas fazia o
        // usuário procurar uma plataforma que "não existe mais" (RN-PLAT-01/04 continuam
        // valendo no backend).
        const ordenadas = [...lista].sort((a, b) => a.codigo.localeCompare(b.codigo, "pt-BR", { numeric: true }));
        setPlataformas(ordenadas);
        // Plataforma pré-selecionada que não existe mais: o <select> mostraria o
        // placeholder enquanto o estado guardaria um id invisível.
        setPlataformaId((atual) => (ordenadas.some((p) => p.id === atual) ? atual : ""));
      })
      .catch((err) => {
        setPlataformas([]);
        setErroPlataformas(mensagemDeErro(err, "Não foi possível carregar as plataformas."));
      });
  }, []);
  useEffect(() => {
    carregarPlataformas();
  }, [carregarPlataformas]);

  useEffect(() => {
    if (!exigeSelecaoDeSetor) return;
    apiFetch<SetorOpcao[]>("/api/v1/setores")
      .then(setSetores)
      .catch(() => setSetores([]));
  }, [exigeSelecaoDeSetor]);

  // Uma consulta de disponibilidade POR DATA (todas as plataformas), compartilhada com a
  // timeline pelo cache do hook. A plataforma escolhida é só um filtro local sobre essa
  // resposta — trocar de plataforma é instantâneo e nunca dispara requisição nova.
  const dataOk = dataIsoValida(data) && data >= hoje;
  const disp = useDisponibilidade(dataOk ? data : null, { usuarioId });
  // Enquanto a data muda, `dados` ainda guarda a resposta da data ANTERIOR — usá-la
  // mostraria os horários do dia errado por um instante.
  const dadosDaData = disp.dados && disp.dados.data === data ? disp.dados : null;
  const recarregarRef = useRef(disp.recarregar);
  useEffect(() => {
    recarregarRef.current = disp.recarregar;
  });

  const plataformaSelecionada = plataformas.find((p) => p.id === plataformaId) ?? null;
  const plataformaNaResposta = dadosDaData?.plataformas.find((p) => p.id === plataformaId) ?? null;
  const indisponivelMotivo =
    descreverIndisponibilidade(plataformaNaResposta?.status) ??
    descreverIndisponibilidade(plataformaSelecionada?.status) ??
    (plataformaNaResposta?.indisponivel ? "indisponível" : null);

  const agenda = useMemo(
    () =>
      dadosDaData && plataformaId && !indisponivelMotivo
        ? calcularAgendaPlataforma(dadosDaData, plataformaId, prioridade, new Date(agoraMs))
        : null,
    [dadosDaData, plataformaId, indisponivelMotivo, prioridade, agoraMs]
  );
  const erroAgenda =
    disp.erro ??
    (dadosDaData && plataformaId && !indisponivelMotivo && !agenda
      ? "Esta plataforma não está disponível para consulta de horários."
      : null);

  // A seleção só vale enquanto cabe na agenda ATUAL (antecedência, expediente, ocupações,
  // duração máxima). Derivada a cada render: uma reserva alheia que chega por SSE, ou o
  // relógio andando, invalida o horário sem depender de um efeito para "lembrar" disso.
  const selecaoAtiva = useMemo(
    () => (agenda && selecao && selecaoValida(agenda, selecao) ? selecao : null),
    [agenda, selecao]
  );
  const fimSelecionadoMin = selecaoAtiva ? fimDaSelecao(selecaoAtiva) : null;

  // Seleção que deixou de valer: descarta e avisa, em vez de deixar o usuário clicar em
  // Reservar num horário que o backend vai recusar.
  useEffect(() => {
    if (!agenda || !selecao || selecaoAtiva) return;
    setSelecao(null);
    setAviso("O horário escolhido não está mais disponível. Escolha outro.");
  }, [agenda, selecao, selecaoAtiva]);

  // Aplica o intervalo do calendário assim que houver plataforma + agenda da data dele.
  useEffect(() => {
    const intervalo = intervaloCalendarioRef.current;
    if (!intervalo || !agenda || !plataformaId || selecao) return;
    if (intervalo.data !== data) return;
    const candidata = selecaoDeIntervalo(intervalo.inicioMin, intervalo.fimMin);
    if (selecaoValida(agenda, candidata)) {
      setSelecao(candidata);
      setAviso(null);
    } else {
      setAviso(
        `O horário do calendário (${minutosParaHora(intervalo.inicioMin)}–${minutosParaHora(intervalo.fimMin)}) não está livre para esta plataforma. Escolha outro.`
      );
    }
  }, [agenda, plataformaId, data, selecao]);

  // Trocar de plataforma reaplica os padrões de automação dela — a menos que o usuário já
  // tenha mexido nas caixas, caso em que a escolha explícita dele é preservada.
  useEffect(() => {
    if (!plataformaSelecionada || automacaoTocada) return;
    // Sem configuração equivalente na plataforma, o padrão do produto é LIGADO.
    setInicioAutomatico(plataformaSelecionada.inicioAutomaticoPadrao ?? true);
    setFimAutomatico(plataformaSelecionada.fimAutomaticoPadrao ?? true);
  }, [plataformaSelecionada, automacaoTocada]);

  // ---------------------------------------------------------------------------------------
  // Validação (mesmos critérios do backend — ele continua sendo a autoridade)
  // ---------------------------------------------------------------------------------------

  // Empresa terceirizada: decidida pelo NOME do setor efetivo (o do usuário, ou o que o
  // Admin escolheu) — não existe flag no banco. Mesma função que a API usa.
  const setorSelecionado = setores.find((s) => s.id === setorSelecionadoId) ?? null;
  const setorEfetivoNome = exigeSelecaoDeSetor ? (setorSelecionado?.nome ?? null) : setorNome;
  const exigeEmpresa = setorExigeEmpresaTerceirizada(setorEfetivoNome);
  const erroEmpresa = validarEmpresaTerceirizada(empresa, exigeEmpresa);
  const erroEmpresaExibido = (empresaTocada || tentouEnviar ? erroEmpresa : null) ?? erroEmpresaServidor;

  // Mesmo validador que o schema zod da API aplica — o formulário nunca pode aceitar o
  // que o backend rejeita, nem o contrário.
  const telefonePreenchido = telefoneContato.trim() !== "";
  const erroTelefone = !telefonePreenchido
    ? "Informe um telefone para contato."
    : !telefoneValido(telefoneContato)
      ? MENSAGEM_TELEFONE_INVALIDO
      : null;
  const erroTelefoneExibido = telefoneTocado || tentouEnviar ? erroTelefone : null;
  const mostrarContatoCompacto = telefoneSalvo !== "" && !alterandoTelefone;

  const motivoValido = motivo.trim().length >= 3;
  const erroMotivoExibido =
    (motivoTocado || tentouEnviar) && !motivoValido ? "Descreva o motivo (mínimo de 3 caracteres)." : null;

  // RF/RN de capacidade: a plataforma selecionada informa o teto oficial (vindo do
  // backend em /api/v1/plataformas) — nunca um valor calculado/hardcoded aqui.
  // QUANTIDADE DE PESSOAS só pode ser validada contra capacidadeOperadores (pessoas),
  // nunca contra capacidade (carga em kg) — os dois são exibidos separadamente.
  const capacidadeKg = plataformaSelecionada?.capacidade ?? null;
  const capacidadeOperadores = plataformaSelecionada?.capacidadeOperadores ?? null;
  const quantidadeNum = Number(quantidadePessoas);
  const quantidadePreenchida = quantidadePessoas.trim() !== "";
  const quantidadeValida = quantidadePreenchida && Number.isInteger(quantidadeNum) && quantidadeNum >= 1;
  const excedeCapacidade = quantidadeValida && capacidadeOperadores !== null && quantidadeNum > capacidadeOperadores;
  const erroQuantidade = !quantidadePreenchida
    ? "Informe a quantidade de pessoas."
    : !quantidadeValida
      ? "Quantidade de pessoas deve ser um número inteiro de pelo menos 1."
      : excedeCapacidade
        ? `Esta plataforma possui capacidade máxima para ${capacidadeOperadores} pessoa(s).`
        : null;

  const ocorrenciasNum = Number(ocorrenciasTexto);
  const ocorrenciasValidas =
    ocorrenciasTexto.trim() !== "" && Number.isInteger(ocorrenciasNum) && ocorrenciasNum >= 2 && ocorrenciasNum <= 12;
  const erroOcorrencias = repetirSemanalmente && !ocorrenciasValidas ? "Informe de 2 a 12 ocorrências." : null;

  // "Mais opções" abre sozinho quando há erro num campo escondido nele — um botão
  // desabilitado por causa de um campo invisível seria um beco sem saída.
  useEffect(() => {
    if (erroQuantidade || erroOcorrencias) setOpcoesAbertas(true);
  }, [erroQuantidade, erroOcorrencias]);

  // Primeiro item que falta, na ordem em que o formulário é preenchido. Vira o texto ao lado
  // do botão desabilitado e a mensagem de um envio por Enter.
  const motivoBloqueio: string | null =
    exigeSelecaoDeSetor && !setorSelecionadoId
      ? "Selecione o setor solicitante."
      : exigeEmpresa && erroEmpresa
        ? "Informe a empresa terceirizada."
        : !plataformaId
          ? "Escolha a plataforma."
          : indisponivelMotivo
            ? `Plataforma ${indisponivelMotivo}.`
            : !dataOk
              ? "Escolha hoje ou uma data futura."
              : !selecaoAtiva || fimSelecionadoMin === null
                ? "Escolha um horário."
                : !motivoValido
                  ? "Descreva o motivo."
                  : erroTelefone
                    ? "Informe um telefone de contato válido."
                    : erroQuantidade
                      ? "Corrija a quantidade de pessoas."
                      : erroOcorrencias
                        ? "Corrija o número de ocorrências."
                        : null;

  // ---------------------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------------------

  function limparFeedbackDeHorario() {
    setAviso(null);
    setErroConflito(null);
    setErro(null);
    setMensagemProximo(null);
    // Invalida uma busca de "próximo horário" em voo: a resposta dela já não corresponde
    // ao que a tela mostra.
    sequenciaProximo.current += 1;
    setProcurandoProximo(false);
  }

  function aoTrocarPlataforma(id: string) {
    setPlataformaId(id);
    setSelecao(null);
    limparFeedbackDeHorario();
  }

  function aoTrocarData(novaData: string) {
    setData(novaData);
    setSelecao(null);
    // O intervalo do calendário era para AQUELA data; a partir daqui a escolha é do usuário.
    intervaloCalendarioRef.current = null;
    limparFeedbackDeHorario();
  }

  function aoTrocarSetor(id: string) {
    setSetorSelecionadoId(id);
    // Saiu de Terceirizados: ZERA o valor (não só esconde) — senão um nome de empresa
    // digitado antes seguiria no estado e nada garantiria que não fosse enviado.
    const novoNome = setores.find((s) => s.id === id)?.nome ?? null;
    if (!setorExigeEmpresaTerceirizada(novoNome)) {
      setEmpresa("");
      setEmpresaTocada(false);
      setErroEmpresaServidor(null);
    }
  }

  function aoEscolherInicio(inicioMin: number) {
    if (!agenda) return;
    intervaloCalendarioRef.current = null;
    limparFeedbackDeHorario();
    setSelecao(selecaoPadrao(agenda, inicioMin, selecaoAtiva));
  }

  // Horário digitado ficou incompleto/inválido: nada de manter por baixo um valor intermediário
  // da digitação (era o "10:04" que sobrava quando o usuário escrevia 10:40).
  function aoInvalidarInicio() {
    setSelecao(null);
    limparFeedbackDeHorario();
  }

  function aoEscolherDuracao(duracao: number | "personalizado") {
    if (!agenda || !selecaoAtiva) return;
    if (duracao !== "personalizado") {
      setSelecao({ inicioMin: selecaoAtiva.inicioMin, duracao, fimPersonalizadoMin: null });
      return;
    }
    // O "Personalizado" nasce no fim que já estava valendo (se for uma das opções da
    // lista), para o usuário só ajustar — não recomeçar.
    const opcoes = opcoesFimPersonalizado(agenda, selecaoAtiva.inicioMin);
    const atual = fimDaSelecao(selecaoAtiva);
    const fim = opcoes.find((o) => o.fimMin === atual)?.fimMin ?? opcoes[0]?.fimMin ?? null;
    if (fim === null) return;
    setSelecao({ inicioMin: selecaoAtiva.inicioMin, duracao: "personalizado", fimPersonalizadoMin: fim });
  }

  function aoEscolherFim(fimMin: number) {
    if (!selecaoAtiva) return;
    setSelecao({ inicioMin: selecaoAtiva.inicioMin, duracao: "personalizado", fimPersonalizadoMin: fimMin });
  }

  async function buscarProximoHorario() {
    if (!plataformaId || !dataOk) return;
    const minha = ++sequenciaProximo.current;
    setProcurandoProximo(true);
    setMensagemProximo(null);
    try {
      const params = new URLSearchParams({
        plataformaId,
        data,
        duracaoMinutos: "60",
        limiteDias: String(LIMITE_DIAS_PROXIMO),
      });
      const resposta = await apiFetch<ProximoHorarioResposta>(`/api/v1/disponibilidade/proximo?${params}`);
      if (minha !== sequenciaProximo.current) return;
      if (resposta.encontrado && resposta.data && resposta.inicioMin !== null) {
        // Troca a data e já deixa o início selecionado: o usuário só confirma. A seleção
        // fica guardada mesmo com a data nova ainda carregando — só é exibida (e validada)
        // quando a agenda daquele dia chega.
        intervaloCalendarioRef.current = null;
        setAviso(null);
        setErroConflito(null);
        setData(resposta.data);
        setSelecao({ inicioMin: resposta.inicioMin, duracao: 60, fimPersonalizadoMin: null });
      } else {
        setMensagemProximo(`Nenhum horário livre encontrado nos próximos ${LIMITE_DIAS_PROXIMO} dias.`);
      }
    } catch (err) {
      if (minha === sequenciaProximo.current) {
        setMensagemProximo(mensagemDeErro(err, "Não foi possível buscar o próximo horário."));
      }
    } finally {
      if (minha === sequenciaProximo.current) setProcurandoProximo(false);
    }
  }

  async function handleSubmit(evento: FormEvent) {
    evento.preventDefault();
    if (salvando) return;
    setErro(null);
    setErroConflito(null);
    setTentouEnviar(true);

    // Só chega aqui por Enter num campo (o botão fica desabilitado): mesma regra do botão.
    if (motivoBloqueio || !plataformaId || !selecaoAtiva || fimSelecionadoMin === null) {
      setErro(motivoBloqueio ?? "Preencha todos os campos obrigatórios.");
      return;
    }

    setSalvando(true);
    try {
      const telefone = telefoneContato.trim();
      await onSalvar({
        plataformaId,
        data,
        horaInicio: minutosParaHora(selecaoAtiva.inicioMin),
        horaFim: minutosParaHora(fimSelecionadoMin),
        quantidadePessoas: quantidadeNum,
        telefoneContato: telefone,
        motivo: motivo.trim(),
        prioridade,
        recorrencia: repetirSemanalmente ? { quantidadeOcorrencias: ocorrenciasNum } : undefined,
        setorId: exigeSelecaoDeSetor ? setorSelecionadoId : undefined,
        inicioAutomatico,
        fimAutomatico,
        // Só quando exigida: enviar o campo em setor interno é dizer algo que não vale.
        empresaTerceirizada: exigeEmpresa ? normalizarEmpresaTerceirizada(empresa) : undefined,
      });
      // A reserva existe: lembra o contato para a próxima e descarta o cache de
      // disponibilidade desta aba (a timeline não pode mostrar o horário ainda livre).
      salvarTelefone(solicitanteNome, telefone);
      invalidarDisponibilidade();
    } catch (err) {
      tratarErroDeEnvio(err);
    } finally {
      setSalvando(false);
    }
  }

  function tratarErroDeEnvio(err: unknown) {
    if (ehHorarioIndisponivel(err)) {
      // Concorrência: alguém pegou o horário entre a escolha e o clique. O backend
      // revalidou (autoridade); aqui só se troca o erro técnico por uma frase clara, mantém
      // o detalhe como texto secundário e recarrega a disponibilidade.
      intervaloCalendarioRef.current = null;
      invalidarDisponibilidade();
      void recarregarRef.current();
      if (repetirSemanalmente) {
        // Série: o 409 costuma ser de uma ocorrência FUTURA (a mensagem diz qual data) e o
        // horário da primeira data pode seguir livre — então a seleção fica; se a primeira
        // data também caiu, a agenda recarregada a invalida sozinha.
        setErroConflito({ titulo: "Uma das datas da série está indisponível.", detalhe: err.message });
      } else {
        setSelecao(null);
        setErroConflito({ titulo: MENSAGEM_HORARIO_INDISPONIVEL, detalhe: err.message });
      }
      return;
    }

    if (err instanceof ApiRequestError && err.status === 422) {
      const { campos, gerais } = lerErrosDeValidacao(err.detalhes);
      const mensagemEmpresa = campos.empresaTerceirizada?.[0];
      if (mensagemEmpresa) {
        setErroEmpresaServidor(mensagemEmpresa);
        setEmpresaTocada(true);
        refEmpresa.current?.focus();
      }
      const outras = [
        ...Object.entries(campos)
          .filter(([campo]) => campo !== "empresaTerceirizada")
          .flatMap(([, mensagens]) => mensagens),
        ...gerais,
      ];
      // Só o erro da empresa: fica inline, sem alerta genérico duplicado.
      if (mensagemEmpresa && outras.length === 0) return;
      setErro(outras[0] ?? err.message);
      return;
    }

    setErro(mensagemDeErro(err, "Erro ao criar reserva."));
  }

  // ---------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------

  const textoBotao = salvando ? "Reservando..." : repetirSemanalmente ? "Criar Série" : "Reservar";
  const desabilitado = salvando || motivoBloqueio !== null;

  // Resumo do que foge do padrão dentro de "Mais opções" (visível com o painel fechado).
  const resumoOpcoes = [
    quantidadeValida && quantidadeNum > 1 ? `${quantidadeNum} pessoas` : null,
    repetirSemanalmente && ocorrenciasValidas ? `Semanal ×${ocorrenciasNum}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const plataformaRotuloResumo = plataformaSelecionada?.codigo ?? plataformaNaResposta?.codigo ?? null;

  return (
    <div className={styles.overlay} onClick={aoClicarNoOverlay}>
      <div className={styles.dialog} ref={refDialogo} {...propsDialogo} data-testid="reserva-modal">
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.header}>
            {/* "Reservar novamente" sempre chega com plataformaId pré-preenchido; a criação
                rápida a partir de um clique no Calendário só preenche data/horário, com
                plataforma em branco — por isso o título distingue pelo primeiro, não pela
                mera presença de valoresIniciais. */}
            <h3 id={idTitulo} className={styles.titulo}>
              {valoresIniciais?.plataformaId ? "Reservar Novamente" : "Nova Reserva"}
            </h3>
            <button type="button" className={styles.fechar} onClick={onClose} aria-label="Fechar">
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.body}>
            {/* Quem solicita e o setor são fatos da sessão: uma linha de leitura, não
                campos. Admin não tem setor de sessão e escolhe o de destino. */}
            <p className={styles.contexto} data-testid="reserva-solicitante">
              <strong>{solicitanteNome}</strong>
              {!exigeSelecaoDeSetor && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{setorNome}</span>
                </>
              )}
            </p>

            {exigeSelecaoDeSetor && (
              <div className={styles.campo}>
                <label htmlFor="rm-setor" className={styles.rotulo}>
                  Setor solicitante *
                </label>
                <select
                  id="rm-setor"
                  className={styles.controle}
                  value={setorSelecionadoId}
                  onChange={(e) => aoTrocarSetor(e.target.value)}
                  aria-required="true"
                >
                  <option value="">Selecione o setor</option>
                  {setores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Só existe para o setor Terceirizados; ao sair dele o estado é zerado (ver
                aoTrocarSetor), não apenas o campo escondido. */}
            {exigeEmpresa && (
              <div className={styles.campo}>
                <label htmlFor="rm-empresa" className={styles.rotulo}>
                  Empresa terceirizada *
                </label>
                <input
                  id="rm-empresa"
                  ref={refEmpresa}
                  type="text"
                  className={styles.controle}
                  data-testid="reserva-empresa"
                  placeholder="Informe o nome da empresa"
                  maxLength={EMPRESA_TERCEIRIZADA_MAX}
                  autoComplete="organization"
                  value={empresa}
                  onChange={(e) => {
                    setEmpresa(e.target.value);
                    setErroEmpresaServidor(null);
                  }}
                  onBlur={() => setEmpresaTocada(true)}
                  aria-required="true"
                  aria-invalid={erroEmpresaExibido ? true : undefined}
                  aria-describedby={erroEmpresaExibido ? "rm-empresa-erro" : undefined}
                />
                {erroEmpresaExibido && (
                  <p id="rm-empresa-erro" className={styles.erroCampo} role="alert">
                    {erroEmpresaExibido}
                  </p>
                )}
              </div>
            )}

            <div className={styles.campo}>
              <label htmlFor="rm-plataforma" className={styles.rotulo}>
                Plataforma *
              </label>
              <select
                id="rm-plataforma"
                className={styles.controle}
                data-testid="reserva-plataforma"
                value={plataformaId}
                onChange={(e) => aoTrocarPlataforma(e.target.value)}
                aria-required="true"
              >
                <option value="">Selecione a plataforma</option>
                {plataformas.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.status === "manutencao" || p.status === "inativa"}>
                    {rotuloPlataforma(p)}
                  </option>
                ))}
              </select>
              {erroPlataformas && (
                <p className={styles.erroCampo} role="alert">
                  {erroPlataformas}{" "}
                  <button type="button" className={styles.linkAcao} onClick={carregarPlataformas}>
                    Tentar novamente
                  </button>
                </p>
              )}
              {plataformaSelecionada && (
                <p className={styles.recurso} data-testid="reserva-recurso">
                  <span>
                    <strong>{capacidadeKg !== null ? `${capacidadeKg} kg` : "—"}</strong> carga máx.
                  </span>
                  <span>
                    <strong>{capacidadeOperadores !== null ? capacidadeOperadores : "—"}</strong>{" "}
                    {capacidadeOperadores === 1 ? "pessoa" : "pessoas"}
                  </span>
                  {plataformaSelecionada.telefoneEmergencia && (
                    // Contato de emergência DO EQUIPAMENTO — diferente do telefone de
                    // contato da reserva. Aparece já aqui porque é o número que alguém
                    // precisa ter à mão antes de subir.
                    <span className={styles.recursoEmergencia}>
                      Emergência {formatarTelefone(plataformaSelecionada.telefoneEmergencia)}
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className={styles.campo}>
              <label htmlFor="rm-data" className={styles.rotulo}>
                Data *
              </label>
              <div className={styles.linhaData}>
                <div role="group" aria-label="Atalhos de data" className={styles.atalhosData}>
                  <button
                    type="button"
                    className={styles.chipData}
                    aria-pressed={data === hoje}
                    onClick={() => aoTrocarData(hoje)}
                  >
                    Hoje
                  </button>
                  <button
                    type="button"
                    className={styles.chipData}
                    aria-pressed={data === amanha}
                    onClick={() => aoTrocarData(amanha)}
                  >
                    Amanhã
                  </button>
                </div>
                <div className={styles.campoData}>
                  <input
                    id="rm-data"
                    type="date"
                    className={styles.controle}
                    data-testid="reserva-data"
                    min={hoje}
                    value={data}
                    onChange={(e) => aoTrocarData(e.target.value)}
                    aria-required="true"
                  />
                </div>
              </div>
            </div>

            {/* Prioridade fica no corpo principal (não em "Mais opções"): urgência muda quais
                horários o seletor abaixo oferece e como a solicitação é tratada. */}
            <div className={styles.campo}>
              <span className={styles.rotulo} id="rm-prioridade-rotulo">
                Prioridade
              </span>
              <div
                role="radiogroup"
                aria-labelledby="rm-prioridade-rotulo"
                className={`${styles.atalhosData} ${styles.atalhosPrioridade}`}
              >
                {PRIORIDADES.map(({ valor, rotulo }) => (
                  <button
                    key={valor}
                    type="button"
                    role="radio"
                    className={styles.chipData}
                    aria-checked={prioridade === valor}
                    data-testid={`reserva-prioridade-${valor}`}
                    onClick={() => setPrioridade(valor)}
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
              {prioridade === "urgente" && (
                <p className={styles.opcaoAjuda}>
                  Urgente dispensa a antecedência mínima e libera horários fora do expediente. Pedidos de
                  colaboradores continuam dependendo de aprovação.
                </p>
              )}
            </div>

            <SeletorHorario
              plataformaRotulo={plataformaId ? (plataformaRotuloResumo ?? "Plataforma") : null}
              indisponivelMotivo={plataformaId ? indisponivelMotivo : null}
              data={data}
              dataValida={dataOk}
              urgente={prioridade === "urgente"}
              agenda={agenda}
              erro={erroAgenda}
              onRecarregar={() => void recarregarRef.current()}
              selecao={selecaoAtiva}
              onEscolherInicio={aoEscolherInicio}
              onInvalidarInicio={aoInvalidarInicio}
              onEscolherDuracao={aoEscolherDuracao}
              onEscolherFim={aoEscolherFim}
              onBuscarProximo={() => void buscarProximoHorario()}
              procurandoProximo={procurandoProximo}
              mensagemProximo={mensagemProximo}
              aviso={aviso}
            />

            <div className={styles.campo}>
              <label htmlFor="rm-motivo" className={styles.rotulo}>
                Motivo *
              </label>
              <textarea
                id="rm-motivo"
                className={styles.controle}
                data-testid="reserva-motivo"
                rows={2}
                maxLength={300}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                onBlur={() => setMotivoTocado(true)}
                aria-required="true"
                aria-invalid={erroMotivoExibido ? true : undefined}
                aria-describedby={erroMotivoExibido ? "rm-motivo-erro" : undefined}
              />
              {erroMotivoExibido && (
                <p id="rm-motivo-erro" className={styles.erroCampo} role="alert">
                  {erroMotivoExibido}
                </p>
              )}
            </div>

            {/* Contato: com um número já informado neste navegador, vira uma linha; sem ele,
                é um campo obrigatório no corpo principal (o cadastro não tem telefone). */}
            {mostrarContatoCompacto ? (
              <p className={styles.contatoLinha} data-testid="reserva-contato-salvo">
                <span>Contato:</span>
                <strong>{formatarTelefone(telefoneContato)}</strong>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className={styles.linkAcao}
                  aria-label="Alterar telefone de contato"
                  onClick={() => {
                    setAlterandoTelefone(true);
                    // O campo só existe depois do render: foco no próximo tick.
                    setTimeout(() => refTelefone.current?.focus(), 0);
                  }}
                >
                  Alterar
                </button>
              </p>
            ) : (
              <div className={styles.campo}>
                <label htmlFor="rm-telefone" className={styles.rotulo}>
                  Telefone para contato *
                </label>
                {/* type="tel" e não "number": o valor carrega parênteses, hífen, +55 e
                    eventualmente ramal — "number" descartaria tudo isso e ainda comeria o
                    zero à esquerda do DDD. */}
                <input
                  id="rm-telefone"
                  ref={refTelefone}
                  type="tel"
                  inputMode="tel"
                  className={styles.controle}
                  data-testid="reserva-telefone"
                  placeholder="(31) 99999-9999"
                  maxLength={40}
                  autoComplete="tel"
                  value={telefoneContato}
                  onChange={(e) => setTelefoneContato(e.target.value)}
                  onBlur={() => setTelefoneTocado(true)}
                  aria-required="true"
                  aria-invalid={erroTelefoneExibido ? true : undefined}
                  aria-describedby={erroTelefoneExibido ? "rm-telefone-erro" : undefined}
                />
                {erroTelefoneExibido && (
                  <p id="rm-telefone-erro" className={styles.erroCampo} role="alert">
                    {erroTelefoneExibido}
                  </p>
                )}
              </div>
            )}

            <div className={styles.opcoes}>
              <button
                type="button"
                className={styles.opcoesToggle}
                aria-expanded={opcoesAbertas}
                aria-controls={idOpcoes}
                onClick={() => setOpcoesAbertas((aberto) => !aberto)}
              >
                <ChevronDown size={16} aria-hidden="true" />
                Mais opções
                {resumoOpcoes && <span className={styles.opcoesResumo}>{resumoOpcoes}</span>}
              </button>

              {opcoesAbertas && (
                <div id={idOpcoes} className={styles.opcoesPainel}>
                  <div className={styles.grade2}>
                    <div className={styles.campo}>
                      <label htmlFor="rm-quantidade" className={styles.rotulo}>
                        Pessoas *
                      </label>
                      <input
                        id="rm-quantidade"
                        type="number"
                        className={styles.controle}
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={quantidadePessoas}
                        onChange={(e) => setQuantidadePessoas(e.target.value)}
                        aria-required="true"
                        aria-invalid={erroQuantidade ? true : undefined}
                        aria-describedby={erroQuantidade ? "rm-quantidade-erro" : undefined}
                      />
                    </div>
                  </div>
                  {erroQuantidade && (
                    <p id="rm-quantidade-erro" className={styles.erroCampo} role="alert">
                      {erroQuantidade}
                    </p>
                  )}

                  <div>
                    <label className={styles.opcaoCheck}>
                      <input
                        type="checkbox"
                        checked={repetirSemanalmente}
                        onChange={(e) => setRepetirSemanalmente(e.target.checked)}
                      />
                      Repetir semanalmente
                    </label>
                    {/* Campo aninhado: só existe depois de marcar a caixa acima. */}
                    {repetirSemanalmente && (
                      <div className={styles.opcaoAninhada}>
                        <label htmlFor="rm-ocorrencias">Ocorrências</label>
                        <input
                          id="rm-ocorrencias"
                          type="number"
                          className={styles.controle}
                          min={2}
                          max={12}
                          inputMode="numeric"
                          value={ocorrenciasTexto}
                          onChange={(e) => setOcorrenciasTexto(e.target.value)}
                          aria-invalid={erroOcorrencias ? true : undefined}
                          aria-describedby={erroOcorrencias ? "rm-ocorrencias-erro" : undefined}
                        />
                        <span className={styles.opcaoAjuda}>de 2 a 12</span>
                      </div>
                    )}
                    {erroOcorrencias && (
                      <p id="rm-ocorrencias-erro" className={styles.erroCampo} role="alert">
                        {erroOcorrencias}
                      </p>
                    )}
                    {repetirSemanalmente && ocorrenciasValidas && (
                      <p className={`${styles.opcaoAjuda} ${styles.opcaoAjudaEspaco}`}>
                        Os horários mostrados valem para a primeira data. As {ocorrenciasNum} ocorrências são criadas em
                        bloco: se qualquer uma delas colidir, nenhuma é criada.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className={styles.opcaoCheck}>
                      <input
                        type="checkbox"
                        checked={inicioAutomatico}
                        onChange={(e) => {
                          setInicioAutomatico(e.target.checked);
                          setAutomacaoTocada(true);
                        }}
                      />
                      Iniciar automaticamente no horário agendado
                    </label>
                    <label className={styles.opcaoCheck}>
                      <input
                        type="checkbox"
                        checked={fimAutomatico}
                        onChange={(e) => {
                          setFimAutomatico(e.target.checked);
                          setAutomacaoTocada(true);
                        }}
                      />
                      Finalizar automaticamente no horário final
                    </label>
                    {/* Nota só quando o usuário DESLIGA a automação: ligada é o padrão e não
                        precisa de explicação; desligada, alguém vai precisar mover a reserva
                        na mão, e isso sim vale um aviso. */}
                    {(!inicioAutomatico || !fimAutomatico) && (
                      <p className={`${styles.opcaoAjuda} ${styles.opcaoAjudaEspaco}`}>
                        Com a automação desligada, esta reserva precisa ser iniciada ou concluída manualmente.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Fora do corpo rolável: sempre à vista quando o usuário toca em Reservar. */}
          {(erroConflito || erro) && (
            <div className={styles.faixaAlerta} role="alert" data-testid="reserva-erro">
              {erroConflito ? (
                <>
                  <span className={styles.faixaAlertaTitulo}>{erroConflito.titulo}</span>
                  <span className={styles.faixaAlertaDetalhe}>{erroConflito.detalhe}</span>
                </>
              ) : (
                erro
              )}
            </div>
          )}

          <div className={styles.footer}>
            {/* Motivo do botão desabilitado, sempre visível (aria-live: muda conforme o
                formulário é preenchido). */}
            <p className={styles.motivoBloqueio} id="rm-motivo-bloqueio" aria-live="polite">
              {motivoBloqueio && !salvando ? motivoBloqueio : ""}
            </p>
            <div className={styles.acoes}>
              <button type="button" className={styles.btnGhost} onClick={onClose}>
                Cancelar
              </button>
              <button
                type="submit"
                className={styles.btnPrimary}
                data-testid="reserva-confirmar"
                disabled={desabilitado}
                aria-describedby="rm-motivo-bloqueio"
              >
                {textoBotao}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
