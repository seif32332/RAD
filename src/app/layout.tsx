import type { Metadata, Viewport } from "next";
import { Cairo } from "next/font/google"; // A premium Arabic font
import { Providers } from "@/context/Providers";
import AppShell from "@/components/AppShell";
import "./globals.css";

const cairo = Cairo({
  subsets: ["arabic", "latin"],
  // 800/900 back the font-extrabold / font-black classes used throughout the UI.
  weight: ["300", "400", "600", "700", "800", "900"],
  variable: "--font-cairo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "رديف - إدارة الموارد البشرية | Radeef HRMS",
  description: "نظام رديف لإدارة الموارد البشرية، متوافق مع نظام العمل السعودي",
};

export const viewport: Viewport = {
  themeColor: "#0A0B10",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className={cairo.variable}>
      <body className={`${cairo.className} bg-slate-50 text-slate-800 antialiased`}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
