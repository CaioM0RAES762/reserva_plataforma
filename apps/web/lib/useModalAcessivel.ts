"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useTravarScrollDaPagina } from "./useTravarScrollDaPagina.js";

const SELETOR_FOCAVEIS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export interface ModalAcessivel {
  // Aplicar no elemento do diálogo (o cartão branco, não o overlay).
  refDialogo: RefObject<HTMLDivElement | null>;
  propsDialogo: {
    role: "dialog";
    "aria-modal": true;
    "aria-labelledby": string;
    tabIndex: -1;
  };
  // Aplicar no <h2>/<h3> do cabeçalho do modal, para que o leitor de tela anuncie o
  // título ao abrir em vez de apenas "diálogo".
  idTitulo: string;
  // Aplicar no overlay: fecha ao clicar fora sem fechar em cliques dentro do cartão.
  aoClicarNoOverlay: (evento: React.MouseEvent) => void;
}

// Acessibilidade de modal, centralizada. Antes, cada modal do sistema era só um par de
// <div> com onClick no overlay: sem role/aria-modal (leitores de tela não anunciavam um
// diálogo), sem foco inicial (o teclado continuava na página atrás), sem armadilha de
// foco (era possível tabular para os campos do fundo, inacessíveis visualmente) e sem
// devolver o foco ao elemento que abriu o modal ao fechar.
export function useModalAcessivel(aoFechar: () => void, idBase: string): ModalAcessivel {
  const refDialogo = useRef<HTMLDivElement | null>(null);
  const refOrigemDoFoco = useRef<HTMLElement | null>(null);
  const idTitulo = `${idBase}-titulo`;

  // Guardado em ref para que o efeito de teclado não seja recriado a cada render quando o
  // chamador passa uma arrow function inline (o caso de todos os modais do app).
  // Trava da rolagem do fundo: implementacao unica, compartilhada com os modais que nao
  // usam este hook completo (ver useTravarScrollDaPagina).
  useTravarScrollDaPagina(true);

  const aoFecharRef = useRef(aoFechar);
  useEffect(() => {
    aoFecharRef.current = aoFechar;
  }, [aoFechar]);

  useEffect(() => {
    refOrigemDoFoco.current = document.activeElement as HTMLElement | null;

    // Foco inicial no primeiro campo interativo (ou no próprio diálogo, se não houver).
    const dialogo = refDialogo.current;
    const primeiroFocavel = dialogo?.querySelector<HTMLElement>(SELETOR_FOCAVEIS);
    (primeiroFocavel ?? dialogo)?.focus();

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") {
        evento.stopPropagation();
        aoFecharRef.current();
        return;
      }
      if (evento.key !== "Tab") return;

      const foco = refDialogo.current?.querySelectorAll<HTMLElement>(SELETOR_FOCAVEIS);
      if (!foco || foco.length === 0) return;
      const primeiro = foco[0];
      const ultimo = foco[foco.length - 1];

      // Circula o foco dentro do diálogo em vez de deixá-lo escapar para a página.
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    }

    document.addEventListener("keydown", aoTeclar, true);
    return () => {
      document.removeEventListener("keydown", aoTeclar, true);
      // Devolve o foco a quem abriu o modal (o botão "Nova Reserva", a linha da tabela…).
      refOrigemDoFoco.current?.focus?.();
    };
  }, []);

  const aoClicarNoOverlay = useCallback((evento: React.MouseEvent) => {
    if (evento.target === evento.currentTarget) {
      aoFecharRef.current();
    }
  }, []);

  return {
    refDialogo,
    propsDialogo: {
      role: "dialog",
      "aria-modal": true,
      "aria-labelledby": idTitulo,
      tabIndex: -1,
    },
    idTitulo,
    aoClicarNoOverlay,
  };
}
