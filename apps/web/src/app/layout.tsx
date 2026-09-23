import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bulk URL Health Checker",
  description: "Submit URLs, watch their health in real time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">
        <div className="flex min-h-screen flex-col">
          <nav className="sticky top-0 z-20 border-b border-stone-200 bg-white">
            <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between px-8">
              <Link
                href="/"
                className="flex items-center gap-2 font-bold text-stone-900 hover:no-underline"
              >
                <span
                  aria-hidden
                  className="grid h-6 w-6 place-items-center rounded bg-indigo-600 text-[11px] font-black text-white"
                >
                  U
                </span>
                <span className="text-sm tracking-tight">URL Health Checker</span>
              </Link>
              <div className="flex items-center gap-6">
                <Link
                  href="/batches"
                  className="text-sm font-medium text-stone-500 transition hover:text-stone-900"
                >
                  History
                </Link>
              </div>
            </div>
          </nav>

          <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 py-12">{children}</main>

          <footer className="border-t border-stone-200 bg-white">
            <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-8 py-5 text-xs text-stone-400">
              <span>10 req/s · concurrency 5 · retries with backoff</span>
              <span>Live results over WebSocket</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
