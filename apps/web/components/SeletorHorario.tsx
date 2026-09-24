"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { horaParaMinutos, minutosParaHora } from "@plataformares/shared";
import styles from "./SeletorHorario.module.css";
import {
  agruparPorPeriodo,
  duracoesPermitidas,
  erroDuracaoPersonalizada,
  conflitosComReservasConfirmadas,
  decidirInicioDigitado,
  erroInicioPersonalizado,
  textoParaSelecaoExterna,
  fimDaSelecao,
  formatarDataResumo,
  formatarDuracao,
  opcoesFimPersonalizado,
  type AgendaPlataforma,
  type OpcaoFim,
  type SelecaoHorario,
} from "./SeletorHorarioCalculos";

// Quantas ocupações listar antes de resumir: a faixa é contexto ("por que não há horário
// aqui"), não um segundo calendário — um dia cheio não pode empurrar o botão de reservar
// para fora da tela.
const MAX_OCUPACOES_VISIVEIS = 4;

interface SeletorHorarioProps {
  /** "PLT-S11" — código do recurso, usado no resumo. Nulo = nenhuma plataforma escolhida. */
  plataformaRotulo: string | null;
  /** manutenção/inativa: a plataforma não pode ser reservada em horário nenhum. */
  indisponivelMotivo: string | null;
  data: string;
  /** Data preenchida, real e não passada — sem isso nem se consulta a disponibilidade. */
  dataValida: boolean;
  urgente: boolean;
  /** null enquanto carrega, em erro ou sem plataforma. */
  agenda: AgendaPlataforma | null;
  erro: string | null;
  onRecarregar: () => void;
  /** Só chega aqui quando a seleção ainda cabe na agenda — o modal descarta a inválida. */
  selecao: SelecaoHorario | null;
  onEscolherInicio: (inicioMin: number) => void;
  /** Horário personalizado apagado/incompleto/inválido: a seleção anterior deixa de valer. */
  onInvalidarInicio: () => void;
  onEscolherDuracao: (duracao: number | "personalizado") => void;
  onEscolherFim: (fimMin: number) => void;
  onBuscarProximo: () => void;
  procurandoProximo: boolean;
  mensagemProximo: string | null;
  /** Aviso não-bloqueante (seleção que deixou de valer, intervalo do calendário ocupado). */
  aviso: string | null;
}

export function SeletorHorario({
  plataformaRotulo,
  indisponivelMotivo,
  data,
  dataValida,
  urgente,
  agenda,
  erro,
  onRecarregar,
  selecao,
  onEscolherInicio,
  onInvalidarInicio,
  onEscolherDuracao,
  onEscolherFim,
  onBuscarProximo,
  procurandoProximo,
  mensagemProximo,
  aviso,
}: SeletorHorarioProps) {
  const idRotuloInicio = useId();
  const idRotuloFim = useId();
  const idInicioPersonalizado = useId();
  const idErroInicioPersonalizado = useId();
  const idDuracaoExata = useId();
  const idErroDuracaoExata = useId();
  const refDuracao = useRef<HTMLDivElement | null>(null);
  // Marcado só pelo clique num chip de início (não por mudanças vindas de fora, como o
  // "próximo horário" ou o intervalo do calendário, que já chegam com a tela posicionada).
  const rolarParaDuracao = useRef(false);

  // ---------------------------------------------------------------------------------------
  // "Personalizado": início e duração digitados livremente (HH:mm, sem grade de 30 min).
  // Texto local — só vira a `selecao` de verdade quando passa em `erroInicioPersonalizado`/
  // `erroDuracaoPersonalizada`, para nunca propagar um horário inválido ao formulário.
  // ---------------------------------------------------------------------------------------
  const [inicioPersonalizadoAberto, setInicioPersonalizadoAberto] = useState(false);
  // O TEXTO digitado é a fonte do campo personalizado; a seleção (em minutos) é derivada dele.
  //
  // Bug corrigido (10:40 virava 10:04): o <input type="time"> emite um valor COMPLETO já no
  // meio da digitação — "1","0","4" produz "10:04" antes do último "0". Esse valor
  // intermediário virava a seleção; o valor final "10:40", se caísse num horário ocupado, era
  // recusado e não substituía a seleção. Aí o efeito que espelhava a SELEÇÃO de volta no campo
  // (disparado a cada recarga da agenda/SSE/relógio) reescrevia o texto com o "10:04" antigo.
  // Agora: (1) o campo só é reescrito quando a seleção muda POR FORA (chip, calendário,
  // "próximo horário") — nunca com um valor que o próprio campo acabou de propor; e (2) texto
  // incompleto ou inválido descarta a seleção, em vez de deixar um valor intermediário
  // valendo por baixo do que está escrito.
  const [inicioTexto, setInicioTexto] = useState("");
  const inicioEmitidoRef = useRef<number | null>(null);
  const inicioSelecionadoMin = selecao?.inicioMin ?? null;
  useEffect(() => {
    if (inicioSelecionadoMin === null) return;
    // Seleção fora da grade de 30 min (calendário, "próximo horário", digitação): o campo é a
    // única forma de mostrar o horário real — nunca um chip avulso na grade.
    if (agenda && !agenda.inicios.includes(inicioSelecionadoMin)) setInicioPersonalizadoAberto(true);
  }, [inicioSelecionadoMin, agenda]);
  useEffect(() => {
    const texto = textoParaSelecaoExterna(inicioSelecionadoMin, inicioEmitidoRef.current);
    if (texto === null) return;
    inicioEmitidoRef.current = null;
    setInicioTexto(texto);
  }, [inicioSelecionadoMin]);
  const erroInicioTexto = useMemo(() => {
    if (!agenda || !inicioTexto) return null;
    return erroInicioPersonalizado(agenda, horaParaMinutos(inicioTexto));
  }, [agenda, inicioTexto]);

  function aplicarInicioTexto(valor: string, rolar: boolean) {
    if (!agenda) return;
    const decisao = decidirInicioDigitado(agenda, valor, inicioSelecionadoMin);
    if (decisao.acao === "invalidar") {
      inicioEmitidoRef.current = null;
      onInvalidarInicio();
    } else if (decisao.acao === "aplicar") {
      inicioEmitidoRef.current = decisao.inicioMin;
      if (rolar) rolarParaDuracao.current = true;
      onEscolherInicio(decisao.inicioMin);
    }
  }

  function aoMudarInicioTexto(valor: string) {
    setInicioTexto(valor);
    aplicarInicioTexto(valor, true);
  }

  // A agenda mudou (recarga, SSE, troca de prioridade): o que está ESCRITO continua valendo e é
  // reavaliado — um horário que passou a caber é aplicado, um que deixou de caber é descartado.
  // O texto em si nunca é reescrito por aqui.
  useEffect(() => {
    if (inicioPersonalizadoAberto && inicioTexto) aplicarInicioTexto(inicioTexto, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenda]);

  const duracaoPersonalizadaAtualMin =
    selecao && selecao.duracao === "personalizado" && selecao.fimPersonalizadoMin !== null
      ? selecao.fimPersonalizadoMin - selecao.inicioMin
      : null;
  const [duracaoTexto, setDuracaoTexto] = useState("");
  // Mesma proteção do início: o que o próprio campo propôs não volta a ser escrito nele.
  const duracaoEmitidaRef = useRef<number | null>(null);
  useEffect(() => {
    if (duracaoPersonalizadaAtualMin === null) return;
    if (duracaoEmitidaRef.current === duracaoPersonalizadaAtualMin) return;
    duracaoEmitidaRef.current = null;
    setDuracaoTexto(minutosParaHora(duracaoPersonalizadaAtualMin));
  }, [duracaoPersonalizadaAtualMin]);
  const erroDuracaoTexto = useMemo(() => {
    if (!agenda || !selecao || !duracaoTexto) return null;
    return erroDuracaoPersonalizada(agenda, selecao.inicioMin, horaParaMinutos(duracaoTexto));
  }, [agenda, selecao, duracaoTexto]);

  function aoMudarDuracaoTexto(valor: string) {
    setDuracaoTexto(valor);
    if (!agenda || !selecao || !valor) return;
    const duracaoMin = horaParaMinutos(valor);
    if (!erroDuracaoPersonalizada(agenda, selecao.inicioMin, duracaoMin)) {
      duracaoEmitidaRef.current = duracaoMin;
      onEscolherFim(selecao.inicioMin + duracaoMin);
    }
  }

  // Grade fixa de 30 min. Um início fora dela (calendário, "próximo horário", digitado) é
  // representado só pelo campo/chip "Personalizado" (ver efeito acima) — nunca por um chip
  // avulso aqui, que poluiria a grade com um horário que não é um atalho de verdade.
  const inicios = agenda?.inicios ?? [];
  const grupos = useMemo(() => agruparPorPeriodo(inicios), [inicios]);

  const fimMin = selecao ? fimDaSelecao(selecao) : null;
  // Urgente sobre reserva confirmada: permitido solicitar, mas nunca escondido.
  const conflitosUrgente =
    urgente && agenda && selecao && fimMin !== null
      ? conflitosComReservasConfirmadas(agenda, selecao.inicioMin, fimMin)
      : [];

  // No celular a grade de horários ocupa a folha inteira e a duração + o resumo (o que se
  // confirma) ficam abaixo da dobra: depois de escolher o início, revela-os com o MÍNIMO de
  // rolagem ("nearest" — não move nada se já estão à vista).
  const inicioSelecionado = selecao?.inicioMin ?? null;
  useEffect(() => {
    if (!rolarParaDuracao.current || inicioSelecionado === null) return;
    rolarParaDuracao.current = false;
    const reduzir = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    refDuracao.current?.scrollIntoView({ block: "nearest", behavior: reduzir ? "auto" : "smooth" });
  }, [inicioSelecionado]);
  const atalhos = useMemo(
    () => (agenda && selecao ? duracoesPermitidas(agenda, selecao.inicioMin) : []),
    [agenda, selecao]
  );
  const opcoesFim = useMemo(
    () => (agenda && selecao ? opcoesFimPersonalizado(agenda, selecao.inicioMin) : []),
    [agenda, selecao]
  );
  // A duração digitada em "Duração exata" quase nunca cai num passo de 30 min — sem uma
  // opção que bata com o valor exato, o <select> controlado do React (nenhum <option> com
  // `selected`) cai no primeiro item por padrão do próprio HTML, mostrando um horário final
  // enganoso mesmo com `selecao.fimPersonalizadoMin` correto por baixo. Injeta a opção que
  // falta para o rótulo exibido nunca divergir do valor real.
  const opcoesFimExibidas = useMemo(() => {
    if (!selecao || selecao.fimPersonalizadoMin === null) return opcoesFim;
    const fim = selecao.fimPersonalizadoMin;
    if (opcoesFim.some((opcao) => opcao.fimMin === fim)) return opcoesFim;
    const extra: OpcaoFim = { fimMin: fim, rotulo: `${minutosParaHora(fim)} · ${formatarDuracao(fim - selecao.inicioMin)}` };
    return [...opcoesFim, extra].sort((a, b) => a.fimMin - b.fimMin);
  }, [opcoesFim, selecao]);

  // Roving tabindex: uma parada de Tab para a grade inteira (até 48 chips) e setas para
  // percorrer — sem isso, quem usa teclado precisaria de dezenas de Tabs para chegar ao motivo.
  function aoTeclarNosChips(evento: KeyboardEvent<HTMLDivElement>) {
    const chaves = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!chaves.includes(evento.key)) return;
    const chips = Array.from(evento.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-inicio]"));
    const atual = chips.findIndex((chip) => chip === document.activeElement);
    if (atual === -1) return;
    evento.preventDefault();
    let proximo = atual;
    if (evento.key === "ArrowRight" || evento.key === "ArrowDown") proximo = Math.min(chips.length - 1, atual + 1);
    if (evento.key === "ArrowLeft" || evento.key === "ArrowUp") proximo = Math.max(0, atual - 1);
    if (evento.key === "Home") proximo = 0;
    if (evento.key === "End") proximo = chips.length - 1;
    chips[proximo]?.focus();
  }

  const anuncio = !plataformaRotulo
    ? ""
    : indisponivelMotivo
      ? `Plataforma ${indisponivelMotivo}.`
      : !dataValida
        ? "Data inválida."
        : erro
          ? erro
          : !agenda
            ? "Carregando horários."
            : inicios.length === 0
              ? "Nenhum horário livre nesta data."
              : `${inicios.length} ${inicios.length === 1 ? "horário livre" : "horários livres"}.`;

  const ocupacoesVisiveis = agenda?.ocupacoes.slice(0, MAX_OCUPACOES_VISIVEIS) ?? [];
  const ocupacoesRestantes = (agenda?.ocupacoes.length ?? 0) - ocupacoesVisiveis.length;
  const expedienteDiaTodo = agenda?.expedienteInicio === "00:00" && agenda?.expedienteFim === "23:59";

  function renderCorpo() {
    if (!plataformaRotulo) {
      return <p className={styles.estado}>Escolha a plataforma para ver os horários.</p>;
    }
    if (indisponivelMotivo) {
      return (
        <p className={`${styles.estado} ${styles.estadoAlerta}`}>
          Esta plataforma está {indisponivelMotivo} e não pode ser reservada em nenhum horário.
        </p>
      );
    }
    if (!dataValida) {
      return <p className={`${styles.estado} ${styles.estadoAlerta}`}>Escolha hoje ou uma data futura.</p>;
    }
    if (erro) {
      return (
        <div className={`${styles.estado} ${styles.estadoAlerta}`}>
          <p>{erro}</p>
          <button type="button" className={styles.acao} onClick={onRecarregar}>
            Tentar novamente
          </button>
        </div>
      );
    }
    if (!agenda) {
      // Sem `agenda` e sem erro é sempre "ainda buscando" (troca de data/plataforma, ou o
      // primeiro render antes de o hook disparar) — o esqueleto reserva a altura da grade.
      return <p className={styles.estado}>Carregando horários…</p>;
    }

    return (
      <>
        {inicios.length === 0 ? (
          <div className={styles.estado}>
            <p>Nenhum horário livre nesta data para esta plataforma.</p>
            <button type="button" className={styles.acao} onClick={onBuscarProximo} disabled={procurandoProximo}>
              {procurandoProximo ? "Procurando…" : "Ver próximo horário disponível"}
            </button>
            {mensagemProximo && <p className={styles.estadoNota}>{mensagemProximo}</p>}
          </div>
        ) : (
          <div role="group" aria-labelledby={idRotuloInicio} onKeyDown={aoTeclarNosChips} className={styles.grupos}>
            {grupos.map((grupo) => {
              // Rótulo de período só quando há mais de um: com um único bloco (expediente
              // curto, dia quase cheio) o cabeçalho seria ruído.
              const rotular = grupos.length > 1;
              return (
                <div key={grupo.rotulo} role="group" aria-label={grupo.rotulo} className={styles.periodo}>
                  {rotular && <span className={styles.periodoRotulo}>{grupo.rotulo}</span>}
                  <div className={styles.chips}>
                    {grupo.inicios.map((inicio) => {
                      const ativo = selecao?.inicioMin === inicio;
                      // Parada única de Tab: o chip ativo, ou o primeiro quando não há seleção.
                      const paradaDeTab = selecao ? ativo : inicio === inicios[0];
                      return (
                        <button
                          key={inicio}
                          type="button"
                          className={styles.chip}
                          data-inicio={inicio}
                          aria-pressed={ativo}
                          tabIndex={paradaDeTab ? 0 : -1}
                          onClick={() => {
                            // Só se o início muda: reclicar o mesmo chip não dispara o efeito de
                            // rolagem, e a marca ficaria pendente para a próxima mudança externa.
                            if (!ativo) rolarParaDuracao.current = true;
                            setInicioPersonalizadoAberto(false);
                            onEscolherInicio(inicio);
                          }}
                        >
                          {minutosParaHora(inicio)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.linhaPersonalizada}>
          <button
            type="button"
            className={styles.chip}
            aria-pressed={inicioPersonalizadoAberto}
            onClick={() => setInicioPersonalizadoAberto((aberto) => !aberto)}
          >
            Personalizado
          </button>
          {inicioPersonalizadoAberto && (
            <>
              <label htmlFor={idInicioPersonalizado} className={styles.somenteLeitor}>
                Horário personalizado
              </label>
              <input
                id={idInicioPersonalizado}
                type="time"
                step={60}
                className={styles.inputHora}
                value={inicioTexto}
                onChange={(evento) => aoMudarInicioTexto(evento.target.value)}
                aria-invalid={erroInicioTexto ? true : undefined}
                aria-describedby={erroInicioTexto ? idErroInicioPersonalizado : undefined}
              />
            </>
          )}
        </div>
        {inicioPersonalizadoAberto && erroInicioTexto && (
          <p id={idErroInicioPersonalizado} className={styles.erroCampo} role="alert">
            {erroInicioTexto}
          </p>
        )}

        {agenda.ocupacoes.length > 0 && (
          <ul className={styles.ocupacoes} aria-label="Horários já ocupados nesta data">
            {ocupacoesVisiveis.map((ocupacao) => (
              <li key={ocupacao.chave}>
                <span className={styles.ocupadoRotulo}>{ocupacao.pendente ? "Solicitado" : "Ocupado"}</span>{" "}
                <span className={styles.faixa}>{ocupacao.faixa}</span> · {ocupacao.descricao}
              </li>
            ))}
            {ocupacoesRestantes > 0 && (
              <li className={styles.ocupacoesResto}>
                e mais {ocupacoesRestantes} {ocupacoesRestantes === 1 ? "ocupação" : "ocupações"}
              </li>
            )}
          </ul>
        )}

        {!expedienteDiaTodo && (
          <p className={styles.dica}>
            {urgente
              ? "Prioridade urgente: horários fora do expediente e dentro da antecedência mínima liberados."
              : `Expediente ${agenda.expedienteInicio}–${agenda.expedienteFim}. Fora dele, só com prioridade Urgente.`}
          </p>
        )}
      </>
    );
  }

  return (
    <div className={styles.seletor} data-testid="seletor-horario">
      <span id={idRotuloInicio} className={styles.rotulo}>
        Horário de início *
      </span>
      {/* Região viva PERSISTENTE e só com um resumo ("12 horários livres"): os chips aparecem/
          somem sozinhos quando outra pessoa reserva ou a data muda, e marcar a grade inteira
          como aria-live faria o leitor de tela recitar dezenas de horários a cada refresh. */}
      <p className={styles.somenteLeitor} aria-live="polite">
        {anuncio}
      </p>
      <div className={styles.corpo}>{renderCorpo()}</div>

      {aviso && (
        <p className={styles.aviso} role="status">
          {aviso}
        </p>
      )}

      {agenda && selecao && fimMin !== null && (
        <div className={styles.duracao} ref={refDuracao}>
          <span className={styles.rotulo}>Duração</span>
          <div role="group" aria-label="Duração da reserva" className={styles.chips}>
            {atalhos.map((minutos) => (
              <button
                key={minutos}
                type="button"
                className={styles.chip}
                aria-pressed={selecao.duracao === minutos}
                onClick={() => onEscolherDuracao(minutos)}
              >
                {formatarDuracao(minutos)}
              </button>
            ))}
            {opcoesFim.length > 0 && (
              <button
                type="button"
                className={styles.chip}
                aria-pressed={selecao.duracao === "personalizado"}
                onClick={() => onEscolherDuracao("personalizado")}
              >
                Personalizado
              </button>
            )}
          </div>

          {selecao.duracao === "personalizado" && opcoesFim.length > 0 && (
            <div className={styles.campoFim}>
              <label htmlFor={idRotuloFim} className={styles.rotulo}>
                Horário final
              </label>
              <div className={styles.linhaFim}>
                <select
                  id={idRotuloFim}
                  className={styles.selectFim}
                  value={String(selecao.fimPersonalizadoMin ?? "")}
                  onChange={(evento) => onEscolherFim(Number(evento.target.value))}
                >
                  {opcoesFimExibidas.map((opcao) => (
                    <option key={opcao.fimMin} value={opcao.fimMin}>
                      {opcao.rotulo}
                    </option>
                  ))}
                </select>
                <label htmlFor={idDuracaoExata} className={styles.somenteLeitor}>
                  Duração exata
                </label>
                <input
                  id={idDuracaoExata}
                  type="time"
                  step={60}
                  className={styles.inputHora}
                  value={duracaoTexto}
                  onChange={(evento) => aoMudarDuracaoTexto(evento.target.value)}
                  aria-invalid={erroDuracaoTexto ? true : undefined}
                  aria-describedby={erroDuracaoTexto ? idErroDuracaoExata : undefined}
                />
              </div>
              {erroDuracaoTexto && (
                <p id={idErroDuracaoExata} className={styles.erroCampo} role="alert">
                  {erroDuracaoTexto}
                </p>
              )}
            </div>
          )}

          {conflitosUrgente.length > 0 && (
            <div className={styles.aviso} role="status" data-testid="aviso-conflito-urgente">
              <p>
                Existe uma reserva nesse período. Por ser uma solicitação urgente, ela poderá ser enviada para
                análise de substituição.
              </p>
              <ul className={styles.ocupacoes}>
                {conflitosUrgente.map((c) => (
                  <li key={`${c.inicioMin}-${c.fimMin}`}>
                    <span className={styles.ocupadoRotulo}>Ocupado</span>{" "}
                    <span className={styles.faixa}>
                      {minutosParaHora(c.inicioMin)}–{minutosParaHora(c.fimMin)}
                    </span>{" "}
                    · {c.descricao}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Resumo destacado: é a frase que o usuário confirma ao clicar em Reservar. Texto
              completo (plataforma, dia, faixa, duração), nunca só cor. */}
          <p className={styles.resumo} role="status" data-testid="resumo-horario">
            <span className={styles.resumoRotulo}>Reserva</span>
            <strong>
              {plataformaRotulo} · {formatarDataResumo(data)} · {minutosParaHora(selecao.inicioMin)}–
              {minutosParaHora(fimMin)} ({formatarDuracao(fimMin - selecao.inicioMin)})
            </strong>
          </p>
        </div>
      )}
    </div>
  );
}
