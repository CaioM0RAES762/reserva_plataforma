import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Instrument_Serif, Archivo, Fraunces } from "next/font/google";
import "./globals.css";

// Fraunces + Archivo são as fontes do design das telas de autenticação. Ficam expostas
// como variáveis próprias (--font-auth-*) e são aplicadas apenas dentro de app/(auth) —
// o restante do app continua em IBM Plex, que é o que as telas internas já usam.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-auth-sans",
  display: "swap",
});

// Fraunces é fonte variável: sem `weight`, next/font entrega todo o eixo de peso (o que
// permite os 400 do contador e os 500 dos títulos). Declarar `weight` junto de `axes` é
// erro de build — os eixos extras só valem na forma variável.
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-auth-display",
  display: "swap",
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-display",
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
      className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} ${instrumentSerif.variable} ${archivo.variable} ${fraunces.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
