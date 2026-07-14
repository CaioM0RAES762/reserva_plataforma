import { chromium, type FullConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CREDENCIAIS = {
  admin: { email: "admin@metalsider.com.br", senha: "AdminForte123" },
  gestor: { email: "gestor.ti@metalsider.com.br", senha: "TesteE2E123!" },
  colaborador: { email: "colaborador.ti@metalsider.com.br", senha: "TesteE2E123!" },
} as const;

export function authFile(perfil: keyof typeof CREDENCIAIS): string {
  return path.resolve(__dirname, "../.auth", `${perfil}.json`);
}

async function preflight(baseURL: string, apiURL: string) {
  const respWeb = await fetch(baseURL).catch(() => null);
  if (!respWeb) {
    throw new Error(
      `apps/web não respondeu em ${baseURL}. Suba o dev server (pnpm --filter @plataformares/web dev) antes de rodar a suite E2E.`
    );
  }
  const respApi = await fetch(`${apiURL}/api/v1/setores`).catch(() => null);
  if (!respApi) {
    throw new Error(
      `apps/api não respondeu em ${apiURL}. Suba o dev server (pnpm --filter @plataformares/api dev) antes de rodar a suite E2E.`
    );
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";
  await preflight(baseURL, "http://localhost:3335");

  const browser = await chromium.launch();
  for (const [perfil, cred] of Object.entries(CREDENCIAIS) as [keyof typeof CREDENCIAIS, typeof CREDENCIAIS[keyof typeof CREDENCIAIS]][]) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(cred.email);
    await page.getByLabel("Senha").fill(cred.senha);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL("**/dashboard", { timeout: 10_000 });
    await context.storageState({ path: authFile(perfil) });
    await context.close();
  }
  await browser.close();
}
