import { describe, expect, it } from "vitest";
import { indiceCiclico, moverParaPrincipal, triarArquivos } from "./galeria";

const arquivo = (name: string, type = "image/png", size = 1000) => ({ name, type, size });

describe("galeria da plataforma", () => {
  it("navegação cíclica 1→2→3→4→1 e 1→4 para trás", () => {
    const visitados = [0];
    for (let i = 0; i < 4; i++) visitados.push(indiceCiclico(visitados[visitados.length - 1], 1, 4));
    expect(visitados).toEqual([0, 1, 2, 3, 0]);
    expect(indiceCiclico(0, -1, 4)).toBe(3);
    expect(indiceCiclico(0, 1, 1)).toBe(0);
  });

  it("tornar principal leva o item para o início mantendo a ordem dos demais", () => {
    expect(moverParaPrincipal(["a", "b", "c", "d"], 2)).toEqual(["c", "a", "b", "d"]);
    expect(moverParaPrincipal(["a", "b"], 0)).toEqual(["a", "b"]);
  });

  it("nunca passa de 4: a quinta é bloqueada", () => {
    const r = triarArquivos([arquivo("1.png"), arquivo("2.png")], 3);
    expect(r.aceitos.map((a) => a.name)).toEqual(["1.png"]);
    expect(r.excedeuLimite).toBe(true);
    expect(triarArquivos([arquivo("x.png")], 4).aceitos).toHaveLength(0);
  });

  it("recusa formato e tamanho inválidos informando qual arquivo", () => {
    const r = triarArquivos([arquivo("a.gif", "image/gif"), arquivo("b.jpg", "image/jpeg", 11 * 1024 * 1024), arquivo("c.webp", "image/webp")], 0);
    expect(r.aceitos.map((a) => a.name)).toEqual(["c.webp"]);
    expect(r.recusados.map((x) => x.nome)).toEqual(["a.gif", "b.jpg"]);
  });
});
