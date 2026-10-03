import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aetheris | Stellar micropayments",
  description: "x402-style API micropayments, powered by Soroban voucher channels.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
