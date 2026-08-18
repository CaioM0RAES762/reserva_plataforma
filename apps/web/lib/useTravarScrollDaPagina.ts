"use client";

import { useEffect } from "react";

// Trava a rolagem da página enquanto um modal está aberto — a rolagem deve acontecer
// DENTRO do corpo do modal, não atrás dele. Sem isso, girar a roda sobre o overlay move a
// listagem do fundo, e ao fechar o modal o usuário perdeu a posição de leitura.
//
// Extraído para um hook próprio porque nem todo modal do sistema usa `useModalAcessivel`:
// o "Novo Bloqueio de Agenda" é renderizado condicionalmente dentro da página
// (`{modalAberto && ...}`), e chamar o hook completo no topo do componente travaria foco e
// rolagem mesmo com o modal fechado. Aqui o comportamento é condicionado por `ativo`.
export function useTravarScrollDaPagina(ativo: boolean): void {
  useEffect(() => {
    if (!ativo) return;
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = anterior;
    };
  }, [ativo]);
}
