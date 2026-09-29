import { describe, expect, it } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// O vitest do web compila JSX no runtime clássico (sem plugin do Next): expõe o React global.
(globalThis as { React?: typeof React }).React = React;
const { DicaCaixaOutros } = await import("./DicaCaixaOutros");

describe("DicaCaixaOutros", () => {
  it("mostra a dica em texto real (versão longa e curta), sem papel de alerta", () => {
    const html = renderToStaticMarkup(createElement(DicaCaixaOutros));
    expect(html).toContain("Não encontrou o e-mail? No Outlook, confira também a aba <strong>Outros</strong>");
    expect(html).toContain("ele pode não aparecer em Destaques.");
    expect(html).toContain("Não encontrou o código? Confira também a aba <strong>Outros</strong> do Outlook.");
    expect(html).not.toContain('role="alert"');
  });
});
