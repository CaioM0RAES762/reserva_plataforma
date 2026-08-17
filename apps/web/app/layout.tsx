import type { Metadata } from "next";
import { IBM_Plex_Mono, Archivo, Fraunces } from "next/font/google";
import "./globals.css";

// Sistema tipográfico único do produto: Fraunces (display/editorial) + Archivo
// (interface/leitura) — nascido no desenho do auth e agora consolidado em toda a app.
// --font-sans/--font-display alimentam globals.css e todas as telas internas;
// --font-auth-sans/--font-auth-display são a MESMA família, carregada de novo só para
// ficar disponível como variável escopada a app/(auth)/layout.module.css (.shell), que
// define seus próprios tokens de cor isolados do restante do app. Não são dois sistemas
// competindo — é uma única decisão tipográfica com dois nomes de variável.
const archivoSans = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const archivoAuthSans = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-auth-sans",
  display: "swap",
});

// Fraunces é fonte variável: sem `weight`, next/font entrega todo o eixo de peso (o que
// permite os 400 do contador e os 500 dos títulos). Declarar `weight` junto de `axes` é
// erro de build — os eixos extras só valem na forma variável.
const frauncesDisplay = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-display",
  display: "swap",
});

const frauncesAuthDisplay = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-auth-display",
  display: "swap",
});

// IBM Plex Mono é o único mono do produto — reservado a informação genuinamente técnica
// ou tabular (horários, códigos, IDs, valores numéricos), nunca usado só para "parecer
// industrial". O auth usa a pilha mono do sistema operacional para o código de turno, o
// que é intencional (ver comentário em AuthSidePanel.module.css).
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PlataformaRes — Sistema de Reservas",
  description: "Gestão e reserva de plataformas por setor — MetalSider",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="pt-BR"
      className={`${archivoSans.variable} ${ibmPlexMono.variable} ${frauncesDisplay.variable} ${archivoAuthSans.variable} ${frauncesAuthDisplay.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
