import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @plataformares/shared não tem passo de build próprio — expõe .ts fonte direto (ver
  // package.json do pacote: "main"/"types" apontam para src/index.ts). Sem isto, o
  // webpack do Next não transforma esse pacote (Next só roda seu pipeline TS/Babel em
  // código de dentro do projeto, não em pacotes do workspace) e falha em "Module not
  // found" assim que algo em apps/web importa um VALOR real de lá — não um `import
  // type`, que é apagado antes de chegar ao bundler. Isso nunca apareceu antes porque
  // até agora o frontend só usava tipos/schemas Zod de @plataformares/shared; agora
  // ReservaModal.tsx importa combinarDataHoraBrasilia/validarAntecedenciaMinima como
  // funções de verdade, para não duplicar a regra de antecedência mínima que o backend
  // já implementa (packages/shared/src/datetime.ts).
  transpilePackages: ["@plataformares/shared"],
  // transpilePackages sozinho não basta: os imports relativos dentro de
  // @plataformares/shared usam extensão .js apontando pra arquivos .ts (convenção do
  // moduleResolution "bundler"/"nodenext" do TypeScript — ver tsconfig.json do pacote).
  // O tsc entende essa convenção nativamente, mas o resolver do webpack não: sem isto,
  // ele procura um "enums.js" que não existe (só "enums.ts") e quebra com "Module not
  // found". extensionAlias diz ao webpack para tentar .ts/.tsx quando um import pedir
  // .js e o arquivo .js não existir.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // Não anuncia a stack nem a versão do framework para quem inspeciona os headers.
  poweredByHeader: false,
  // Compressão gzip nas respostas do Next (HTML/JS/CSS) — o padrão já é true, explicitado
  // aqui para não ser desligado por engano num ajuste futuro de configuração.
  compress: true,
  async redirects() {
    return [
      {
        source: "/",
        destination: "/login",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        // Cabeçalhos de segurança do lado do frontend. A API já usa Helmet desde a S6,
        // mas o app Next servia suas páginas sem nenhum deles — um XSS refletido ou um
        // clickjacking sobre a UI não encontrava barreira alguma.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nenhuma tela do sistema usa câmera, microfone ou geolocalização.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
