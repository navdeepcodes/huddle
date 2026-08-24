import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import AuthBoot from "@/components/AuthBoot";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Huddle",
  description: "Tell Huddle what to build, and watch it build a real product.",
};

/**
 * Phase 32: `viewport-fit=cover` is what makes env(safe-area-inset-*)
 * resolve to real device values instead of 0 on notched/rounded-corner
 * phones - required for the mobile companion's sticky bottom composer
 * and full-bleed overlays to sit correctly above the home indicator.
 * `themeColor` matches --bg-base so the OS status/nav bar chrome reads
 * as part of the app, not a mismatched white bar. maximumScale left at
 * Next's own default (unset = no pinch-zoom lock) - locking zoom is an
 * accessibility regression this phase doesn't need to make.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthBoot />
        {children}
      </body>
    </html>
  );
}
