// Sprint S14 — teste de carga leve (RNF-01/RNF-03): 50 usuários simultâneos em rotas de
// leitura representativas + 10 conexões SSE de Painel TV, medindo p95 e taxa de erro.
//
// Simplificação documentada: reaproveita 1 sessão JWT real (Admin) para as 50 "conexões
// simultâneas" em vez de 50 contas distintas — RNF-03 fala em capacidade do servidor sob
// carga concorrente, não em unicidade de conta; a característica que o teste mede
// (throughput/latência da API sob N conexões simultâneas) independe de quantas contas
// distintas emitiram essas conexões.
const API = "http://localhost:3335";
const DURACAO_MS = 30_000;
const USUARIOS_SIMULTANEOS = 50;
const CONEXOES_SSE = 10;

const ADMIN = { email: "admin@metalsider.com.br", senha: "AdminForte123" };

async function login() {
  const resp = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN.email, senha: ADMIN.senha }),
  });
  if (!resp.ok) throw new Error(`Login falhou: ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie");
  const token = setCookie?.match(/token=([^;]+)/)?.[1];
  if (!token) throw new Error("Cookie de sessão não retornado no login.");
  return `token=${token}`;
}

async function gerarPainelToken(cookie) {
  const resp = await fetch(`${API}/api/v1/painel/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ nome: `E2E S14 — Carga (${Date.now()})`, setorId: null }),
  });
  if (!resp.ok) throw new Error(`Criação de token do Painel TV falhou: ${resp.status}`);
  const dados = await resp.json();
  return { id: dados.id, token: dados.token };
}

async function revogarPainelToken(cookie, id) {
  await fetch(`${API}/api/v1/painel/tokens/${id}`, { method: "DELETE", headers: { cookie } }).catch(() => {});
}

const ROTAS_LEITURA = [
  "/api/v1/dashboard/kpis",
  "/api/v1/reservas",
  "/api/v1/plataformas",
  "/api/v1/historico",
  "/api/v1/setores",
];

function percentil(valoresOrdenados, p) {
  if (valoresOrdenados.length === 0) return 0;
  const idx = Math.min(valoresOrdenados.length - 1, Math.ceil((p / 100) * valoresOrdenados.length) - 1);
  return valoresOrdenados[idx];
}

async function usuarioVirtual(cookie, fimEm, latencias, erros) {
  while (Date.now() < fimEm) {
    const rota = ROTAS_LEITURA[Math.floor(Math.random() * ROTAS_LEITURA.length)];
    const inicio = performance.now();
    try {
      const resp = await fetch(`${API}${rota}`, { headers: { cookie } });
      const duracao = performance.now() - inicio;
      latencias.push(duracao);
      if (!resp.ok) erros.push({ rota, status: resp.status });
      await resp.arrayBuffer(); // drena o corpo
    } catch (err) {
      latencias.push(performance.now() - inicio);
      erros.push({ rota, status: "network-error", detalhe: String(err) });
    }
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  }
}

async function conexaoSSE(token, fimEm, contadorEventos) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DURACAO_MS + 2000);
  try {
    const resp = await fetch(`${API}/api/v1/eventos?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      contadorEventos.falhas++;
      return;
    }
    contadorEventos.conexoesAbertas++;
    const reader = resp.body.getReader();
    while (Date.now() < fimEm) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) contadorEventos.bytesRecebidos += value.length;
    }
    await reader.cancel().catch(() => {});
  } catch (err) {
    if (!controller.signal.aborted) contadorEventos.falhas++;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  console.log(`=== Teste de carga S14 — ${USUARIOS_SIMULTANEOS} usuários + ${CONEXOES_SSE} SSE, ${DURACAO_MS / 1000}s ===`);
  const cookie = await login();
  const { id: painelTokenId, token: painelToken } = await gerarPainelToken(cookie);
  console.log("Login OK, token de Painel TV gerado para as conexões SSE.");

  const fimEm = Date.now() + DURACAO_MS;
  const latencias = [];
  const erros = [];
  const contadorEventos = { conexoesAbertas: 0, bytesRecebidos: 0, falhas: 0 };

  const inicioTeste = Date.now();
  const promessasUsuarios = Array.from({ length: USUARIOS_SIMULTANEOS }, () =>
    usuarioVirtual(cookie, fimEm, latencias, erros)
  );
  const promessasSSE = Array.from({ length: CONEXOES_SSE }, () => conexaoSSE(painelToken, fimEm, contadorEventos));

  await Promise.all([...promessasUsuarios, ...promessasSSE]);
  const duracaoRealMs = Date.now() - inicioTeste;

  await revogarPainelToken(cookie, painelTokenId);

  const ordenadas = [...latencias].sort((a, b) => a - b);
  const p50 = percentil(ordenadas, 50);
  const p95 = percentil(ordenadas, 95);
  const p99 = percentil(ordenadas, 99);
  const taxaErro = latencias.length > 0 ? (erros.length / latencias.length) * 100 : 0;

  const relatorio = {
    duracaoRealMs,
    usuariosSimultaneos: USUARIOS_SIMULTANEOS,
    conexoesSSEAlvo: CONEXOES_SSE,
    sse: contadorEventos,
    totalRequisicoes: latencias.length,
    totalErros: erros.length,
    taxaErroPercent: Number(taxaErro.toFixed(3)),
    latenciaMs: {
      p50: Number(p50.toFixed(1)),
      p95: Number(p95.toFixed(1)),
      p99: Number(p99.toFixed(1)),
      min: Number(Math.min(...latencias).toFixed(1)),
      max: Number(Math.max(...latencias).toFixed(1)),
    },
    rnf01_p95_leitura_300ms: p95 <= 300,
    rnf03_50_usuarios_10_sse: contadorEventos.conexoesAbertas >= CONEXOES_SSE && contadorEventos.falhas === 0,
    amostraErros: erros.slice(0, 10),
  };

  console.log(JSON.stringify(relatorio, null, 2));

  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  fs.writeFileSync(path.join(__dirname, "load-test-report.json"), JSON.stringify(relatorio, null, 2), "utf-8");
  console.log(`\nRelatório salvo em ${path.join(__dirname, "load-test-report.json")}`);
}

main().catch((err) => {
  console.error("Falha no teste de carga:", err);
  process.exit(1);
});
