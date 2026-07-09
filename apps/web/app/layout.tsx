import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlataformaRes — Sistema de Reservas",
  description: "Gestão e reserva de plataformas por setor — MetalSider",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
