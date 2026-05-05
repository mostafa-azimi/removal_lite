import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shiphero Pick List",
  description: "Generate a printable, bin-sorted pick list from a Shiphero order CSV.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
