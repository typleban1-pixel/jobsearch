import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Job search portal",
  description: "Private job search, matching and application system.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
