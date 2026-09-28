import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "Live global risk intelligence: conflict, political instability, natural hazards, infrastructure and cyber signals on a 3D globe, with an explainable Pulse Level for every country.";

export const metadata: Metadata = {
  // Absolute URLs for the share image and canonical link.
  metadataBase: new URL("https://geopulseanalytics.com"),
  title: {
    default: "GeoPulse - Live Global Risk Intelligence",
    template: "%s - GeoPulse",
  },
  description: DESCRIPTION,
  applicationName: "GeoPulse",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "GeoPulse",
    title: "GeoPulse - Live Global Risk Intelligence",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "GeoPulse - Live Global Risk Intelligence",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="flex h-full flex-col bg-black">{children}</body>
    </html>
  );
}
