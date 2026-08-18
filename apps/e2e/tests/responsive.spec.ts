import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authFile } from "./global-setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(__dirname, "../responsive-shots");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Sprint S14, Gate de Aceite item 2: matriz de responsividade (360/600/900/1920px) das
// telas principais, com evidência real (captura em arquivo, não a ferramenta de preview
// interativa — instável neste ambiente segundo os relatórios de S8-S13). Cada combinação
// tela × breakpoint gera um PNG em apps/e2e/responsive-shots/ E é checada
// automaticamente contra overflow horizontal (sintoma mais comum de quebra de layout
// responsivo — barra de rolagem horizontal indesejada).
const BREAKPOINTS = [
  { largura: 360, altura: 800, rotulo: "360px" },
  { largura: 600, altura: 900, rotulo: "600px" },
  { largura: 900, altura: 900, rotulo: "900px" },
  { largura: 1920, altura: 1080, rotulo: "1920px" },
];

interface Tela {
  nome: string;
  url: string;
  perfil: "admin" | "gestor" | "colaborador" | null;
  aguardar: string; // texto que confirma que a tela carregou
}

const TELAS: Tela[] = [
  { nome: "login", url: "/login", perfil: null, aguardar: "Entrar" },
  { nome: "dashboard", url: "/dashboard", perfil: "admin", aguardar: "PlataformaRes" },
  { nome: "reservas", url: "/reservas", perfil: "admin", aguardar: "Nova Reserva" },
  { nome: "fila-aprovacoes", url: "/reservas/aprovacoes", perfil: "admin", aguardar: "Fila de Aprovações" },
  { nome: "calendario", url: "/calendario", perfil: "admin", aguardar: "PlataformaRes" },
  { nome: "plataformas", url: "/plataformas", perfil: "admin", aguardar: "PlataformaRes" },
  { nome: "bloqueios-agenda", url: "/plataformas/bloqueios", perfil: "admin", aguardar: "Bloqueios de Agenda" },
  { nome: "relatorios", url: "/relatorios", perfil: "admin", aguardar: "Relatórios & Indicadores" },
  { nome: "administracao-usuarios", url: "/administracao/usuarios", perfil: "admin", aguardar: "PlataformaRes" },
];

const resultados: { tela: string; breakpoint: string; overflowPx: number; status: "OK" | "AJUSTE" }[] = [];

for (const tela of TELAS) {
  test.describe(`Responsividade — ${tela.nome}`, () => {
    if (tela.perfil) {
      test.use({ storageState: authFile(tela.perfil) });
    }

    for (const bp of BREAKPOINTS) {
      test(`${tela.nome} @ ${bp.rotulo}`, async ({ page }) => {
        await page.setViewportSize({ width: bp.largura, height: bp.altura });
        await page.goto(tela.url);
        await expect(page.getByText(tela.aguardar).first()).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(150); // acomoda re-layout/transições CSS

        const overflowPx = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );

        await page.screenshot({
          path: path.join(SHOTS_DIR, `${tela.nome}_${bp.largura}.png`),
          fullPage: true,
        });

        resultados.push({
          tela: tela.nome,
          breakpoint: bp.rotulo,
          overflowPx,
          status: overflowPx > 4 ? "AJUSTE" : "OK",
        });

        // Tolerância de 4px para arredondamento de scrollbar/subpixel.
        expect(overflowPx, `overflow horizontal em ${tela.nome} @ ${bp.rotulo}`).toBeLessThanOrEqual(4);
      });
    }
  });
}


test.afterAll(async () => {
  const linhas = [
    "| Tela | Breakpoint | Overflow horizontal (px) | Status |",
    "|---|---|---|---|",
    ...resultados.map((r) => `| ${r.tela} | ${r.breakpoint} | ${r.overflowPx} | ${r.status} |`),
  ];
  fs.writeFileSync(path.resolve(__dirname, "../responsive-matrix.md"), linhas.join("\n") + "\n", "utf-8");
});
