import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Ada", template: "%s · Ada" },
  description: "Ada teaches what no one bothered to make a course for.",
  openGraph: {
    title: "Ada",
    description: "Ada teaches what no one bothered to make a course for.",
  },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1120" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} dark`}>
      <body className="min-h-dvh bg-paper text-ink antialiased selection:bg-accent/25 selection:text-ink">{children}</body>
    </html>
  );
}
