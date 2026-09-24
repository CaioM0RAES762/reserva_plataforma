import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authFile } from "./global-setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(__dirname, "../calendar-shots");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

test.use({ storageState: authFile("admin") });

async function abrirCalendario(page: Page, largura: number, altura: number) {
  await page.setViewportSize({ width: largura, height: altura });
  await page.goto("/calendario");
  await expect(page.getByRole("region", { name: /Grade de reservas/ })).toBeVisible({ timeout: 15_000 });
}

async function metricasDaGrade(page: Page) {
  return page.getByRole("region", { name: /Grade de reservas/ }).evaluate((grade: HTMLElement) => ({
    colunas: grade.querySelectorAll("[data-data]").length,
    largura: grade.clientWidth,
    larguraRolavel: grade.scrollWidth,
    altura: grade.clientHeight,
    alturaRolavel: grade.scrollHeight,
    overflowY: getComputedStyle(grade).overflowY,
    maxHeight: getComputedStyle(grade).maxHeight,
    largurasColunas: Array.from(grade.querySelectorAll<HTMLElement>("[data-data]"), (coluna) =>
      Math.round(coluna.getBoundingClientRect().width)
    ),
  }));
}

test("mobile: Dia, 3 dias, Semana, filtros e criação rápida", async ({ page }) => {
  await abrirCalendario(page, 390, 844);

  await expect(page.getByRole("button", { name: "Dia", exact: true })).toHaveAttribute("aria-pressed", "true");
  let metricas = await metricasDaGrade(page);
  expect(metricas.colunas).toBe(1);
  expect(metricas.larguraRolavel).toBe(metricas.largura);
  expect(metricas.alturaRolavel).toBe(metricas.altura);
  expect(metricas.maxHeight).toBe("none");
  await page.screenshot({ path: path.join(SHOTS_DIR, "calendario-390-hoje.png"), fullPage: true });

  await page.getByRole("button", { name: "3 dias", exact: true }).click();
  await expect(page.getByRole("region", { name: "Grade de reservas de 3 dias" })).toBeVisible();
  metricas = await metricasDaGrade(page);
  expect(metricas.colunas).toBe(3);
  expect(metricas.larguraRolavel).toBeGreaterThan(metricas.largura);
  expect(Math.min(...metricas.largurasColunas)).toBeGreaterThanOrEqual(260);
  expect(metricas.alturaRolavel).toBe(metricas.altura);
  await page.screenshot({ path: path.join(SHOTS_DIR, "calendario-390-3-dias.png"), fullPage: true });

  await page.getByRole("button", { name: "Semana", exact: true }).click();
  await expect(page.getByRole("region", { name: "Grade de reservas de 7 dias" })).toBeVisible();
  metricas = await metricasDaGrade(page);
  expect(metricas.colunas).toBe(7);
  expect(metricas.larguraRolavel).toBeGreaterThan(metricas.largura);
  expect(Math.min(...metricas.largurasColunas)).toBeGreaterThanOrEqual(260);
  expect(metricas.alturaRolavel).toBe(metricas.altura);
  await page.screenshot({ path: path.join(SHOTS_DIR, "calendario-390-7-dias.png"), fullPage: true });

  // O painel (mini calendário + filtros por setor, que também são a legenda) vira popover.
  await page.getByRole("button", { name: /^Filtros/ }).click();
  await expect(page.locator("#calendario-painel")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS_DIR, "calendario-390-filtros.png"), fullPage: true });
  await page.getByRole("button", { name: /^Filtros/ }).click();
  await expect(page.locator("#calendario-painel")).toBeHidden();

  await page.getByRole("button", { name: "Dia", exact: true }).click();
  const primeiraColuna = page.locator("[data-data]").first();
  const dataDaColuna = await primeiraColuna.getAttribute("data-data");
  await primeiraColuna.click({ position: { x: 120, y: 90 } });
  await expect(page.getByTestId("reserva-modal")).toBeVisible();
  await expect(page.getByTestId("reserva-data")).toHaveValue(dataDaColuna ?? "");
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
});

test("mobile: reserva e bloqueio continuam abrindo detalhes", async ({ page }) => {
  await abrirCalendario(page, 390, 844);

  const reserva = page.locator('[data-cal-item="reserva"]').first();
  await expect(reserva).toBeVisible();
  await reserva.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Fechar detalhe da reserva" }).click();

  const bloqueio = page.getByRole("button", { name: /Bloqueio:/ }).first();
  await expect(bloqueio).toBeVisible();
  await bloqueio.click();
  await expect(page.getByRole("dialog", { name: /Sala de Reuniões|Todas as plataformas/ })).toBeVisible();
  await page.getByRole("button", { name: "Fechar detalhe do bloqueio" }).click();
});

test("tablet e desktop: defaults responsivos", async ({ page }) => {
  for (const viewport of [
    { width: 768, height: 1024, periodo: "3 dias", colunas: 3 },
    { width: 820, height: 1180, periodo: "3 dias", colunas: 3 },
    { width: 1024, height: 900, periodo: "3 dias", colunas: 3 },
    { width: 1920, height: 1080, periodo: "Semana", colunas: 7 },
  ]) {
    await abrirCalendario(page, viewport.width, viewport.height);
    await expect(page.getByRole("button", { name: viewport.periodo, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const metricas = await metricasDaGrade(page);
    expect(metricas.colunas).toBe(viewport.colunas);
    expect(metricas.maxHeight).toBe("none");
    if (viewport.width <= 1100) {
      // Tablet: altura natural, quem rola é a página.
      expect(metricas.alturaRolavel).toBe(metricas.altura);
    } else {
      // Desktop: a grade ocupa a altura útil e rola por dentro; a página não rola e as sete
      // colunas cabem sem rolagem horizontal. O painel direito fica ao lado da grade.
      expect(metricas.overflowY).toBe("auto");
      expect(metricas.larguraRolavel).toBe(metricas.largura);
      const rolagemDocumento = await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight
      );
      expect(rolagemDocumento).toBeLessThanOrEqual(1);
      await expect(page.locator("#calendario-painel")).toBeVisible();
    }
    const overflowDocumento = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflowDocumento).toBeLessThanOrEqual(1);
  }

  await page.screenshot({ path: path.join(SHOTS_DIR, "calendario-1920-semana.png"), fullPage: true });
});
