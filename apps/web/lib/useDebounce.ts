"use client";

import { useEffect, useState } from "react";

// Debounce aplicado APENAS ao texto digitado.
//
// Todas as telas de listagem colocavam a busca inteira (texto + selects + datas) atrás de
// um setTimeout de 250 ms: escolher um status na combobox, uma data no calendário ou até
// o primeiro carregamento da página esperavam esse atraso sem motivo — só a digitação
// precisa dele. Isolando o debounce no campo de texto, os demais filtros respondem na
// hora e a tela abre 250 ms mais cedo.
export function useDebounce<T>(valor: T, atrasoMs = 250): T {
  const [valorComAtraso, setValorComAtraso] = useState(valor);

  useEffect(() => {
    if (valor === valorComAtraso) return;
    const timer = setTimeout(() => setValorComAtraso(valor), atrasoMs);
    return () => clearTimeout(timer);
  }, [valor, atrasoMs, valorComAtraso]);

  return valorComAtraso;
}
