"use client";

import { formatarDuracaoPeriodo } from "@plataformares/shared";
import styles from "./ReservaModal.module.css";
import type { ErrosPeriodo } from "../lib/periodoVariosDias";

// Bloco "Vários dias" da Nova Reserva: início (a data vem do campo Data acima) e fim
// completos, com a duração calculada, o limite configurado e o conflito informado pela API.
// O fluxo de um dia (SeletorHorario) não muda — este bloco só aparece quando escolhido.

interface PeriodoVariosDiasProps {
  data: string;
  horaInicio: string;
  dataFim: string;
  horaFim: string;
  onHoraInicio: (valor: string) => void;
  onDataFim: (valor: string) => void;
  onHoraFim: (valor: string) => void;
  /** Exibidos só depois de o campo ser tocado ou de uma tentativa de envio. */
  erros: ErrosPeriodo;
  duracaoMinutos: number;
  atravessaDias: boolean;
  duracaoMaximaHoras: number | null;
  /** Checagem em tempo real (GET /reservas/conflitos): null = livre ou ainda não verificado. */
  conflito: string | null;
  verificando: boolean;
}

export function PeriodoVariosDias(props: PeriodoVariosDiasProps) {
  const { erros } = props;
  const dataBr = (iso: string) => iso.split("-").reverse().join("/");
  // A duração aparece sempre que o período é válido (mesmo acima do limite: o usuário vê quanto
  // passou); "—" só quando não há duração calculável.
  const duracaoOk = props.duracaoMinutos > 0 && !erros.dataFim;

  return (
    <div className={styles.campo} data-testid="reserva-periodo-varios-dias">
      <div className={styles.grade2}>
        <div className={styles.campo}>
          <label htmlFor="rm-hora-inicio" className={styles.rotulo}>
            Início *
          </label>
          <input
            id="rm-hora-inicio"
            type="time"
            className={styles.controle}
            data-testid="reserva-hora-inicio"
            value={props.horaInicio}
            onChange={(e) => props.onHoraInicio(e.target.value)}
            aria-required="true"
            aria-invalid={erros.horaInicio ? true : undefined}
            aria-describedby={erros.horaInicio ? "rm-hora-inicio-erro" : "rm-hora-inicio-ajuda"}
          />
          <span id="rm-hora-inicio-ajuda" className={styles.opcaoAjuda}>
            em {dataBr(props.data)}
          </span>
          {erros.horaInicio && (
            <p id="rm-hora-inicio-erro" className={styles.erroCampo} role="alert">
              {erros.horaInicio}
            </p>
          )}
        </div>
        <div className={styles.campo}>
          <label htmlFor="rm-data-fim" className={styles.rotulo}>
            Data final *
          </label>
          <input
            id="rm-data-fim"
            type="date"
            className={styles.controle}
            data-testid="reserva-data-fim"
            min={props.data}
            value={props.dataFim}
            onChange={(e) => props.onDataFim(e.target.value)}
            aria-required="true"
            aria-invalid={erros.dataFim ? true : undefined}
            aria-describedby={erros.dataFim ? "rm-data-fim-erro" : undefined}
          />
          {erros.dataFim && (
            <p id="rm-data-fim-erro" className={styles.erroCampo} role="alert">
              {erros.dataFim}
            </p>
          )}
        </div>
      </div>

      <div className={styles.grade2}>
        <div className={styles.campo}>
          <label htmlFor="rm-hora-fim" className={styles.rotulo}>
            Fim *
          </label>
          <input
            id="rm-hora-fim"
            type="time"
            className={styles.controle}
            data-testid="reserva-hora-fim"
            value={props.horaFim}
            onChange={(e) => props.onHoraFim(e.target.value)}
            aria-required="true"
            aria-invalid={erros.horaFim ? true : undefined}
            aria-describedby={erros.horaFim ? "rm-hora-fim-erro" : undefined}
          />
          {erros.horaFim && (
            <p id="rm-hora-fim-erro" className={styles.erroCampo} role="alert">
              {erros.horaFim}
            </p>
          )}
        </div>
        <div className={styles.campo}>
          <span className={styles.rotulo}>Duração</span>
          <p className={styles.duracaoValor} data-testid="reserva-duracao" aria-live="polite">
            {duracaoOk ? formatarDuracaoPeriodo(props.duracaoMinutos) : "—"}
          </p>
          {props.duracaoMaximaHoras !== null && (
            <span className={styles.opcaoAjuda}>Limite: {props.duracaoMaximaHoras}h</span>
          )}
        </div>
      </div>

      {duracaoOk && props.atravessaDias && (
        <p className={styles.opcaoAjuda} data-testid="reserva-atravessa-dias">
          A plataforma fica reservada de {dataBr(props.data)} {props.horaInicio} até {dataBr(props.dataFim)}{" "}
          {props.horaFim}, inclusive nas noites entre esses dias.
        </p>
      )}
      {erros.geral && (
        <p className={styles.erroCampo} role="alert">
          {erros.geral}
        </p>
      )}
      {props.verificando && <p className={styles.opcaoAjuda}>Verificando disponibilidade…</p>}
      {!props.verificando && props.conflito && (
        <p className={styles.erroCampo} role="alert" data-testid="reserva-conflito-periodo">
          {props.conflito}
        </p>
      )}
    </div>
  );
}
