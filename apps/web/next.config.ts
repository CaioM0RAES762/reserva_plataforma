import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
