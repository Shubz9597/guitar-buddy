import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const origin = host
    ? `${protocol}://${host}`
    : "https://pickpulse-guitar-bpm.shubham-misra95.chatgpt.site";
  const socialImage = new URL("/og.png", origin).toString();

  return {
    title: "PickPulse — Guitar Timing Trainer",
    description:
      "A loud live metronome, guitar BPM detector, and early/late timing graph.",
    openGraph: {
      title: "PickPulse — Guitar Timing Trainer",
      description:
        "Practice against a loud click and see every guitar hit early or late.",
      images: [{ url: socialImage, width: 1664, height: 922 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "PickPulse — Guitar Timing Trainer",
      description:
        "Practice against a loud click and see every guitar hit early or late.",
      images: [socialImage],
    },
  };
}

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
