import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PickPulse — Live Guitar BPM Detector",
  description:
    "Hear your guitar pick attacks and estimate the BPM of quarter, eighth, or sixteenth-note practice phrases.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
