import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";

import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Phloem | Private financial authority for autonomous agents",
  description: "Delegate policy-bounded spending authority to autonomous agents without handing over treasury custody.",
  openGraph: {
    title: "Phloem | Capital flows. Authority stays bounded.",
    description: "Private, policy-bounded agent payments on Stellar.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={ibmPlexSans.variable}>{children}</body>
    </html>
  );
}
