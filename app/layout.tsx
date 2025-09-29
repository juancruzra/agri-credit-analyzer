import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agro Credit Optimizer — Demo",
  description: "Monte Carlo para crédito agro — Núcleo vs NEA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900">
        {children}
      </body>
    </html>
  );
}
