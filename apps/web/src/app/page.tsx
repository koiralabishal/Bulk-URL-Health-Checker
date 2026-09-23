import AnalyzeForm from "@/components/analyze-form";

const META = ["up to 1,000 URLs", "10 req/s", "3 retries on 5xx", "live WebSocket"];

const STEPS = [
  {
    n: "01",
    title: "Paste your URLs",
    body: "One per line, or upload a CSV — the first column is read.",
  },
  {
    n: "02",
    title: "Run the check",
    body: "A worker pool fetches every URL under a global rate limit, with backoff retries for 5xx and timeouts.",
  },
  {
    n: "03",
    title: "Read the results",
    body: "Status, timing and page titles stream in over WebSocket — no refresh needed.",
  },
];

export default function Home() {
  return (
    <div className="w-full">
      <section className="w-full">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">
          Bulk URL health checker
        </p>
        <h1 className="mx-auto mt-4 w-full whitespace-nowrap text-center text-[clamp(1.3rem,5.5vw,3.75rem)] font-black leading-[1.06] tracking-tight">
          Every link,{" "}
          <span className="font-serif font-medium italic text-indigo-600">checked live.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-lg text-center text-base leading-relaxed text-stone-500 sm:text-[17px]">
          Paste a list, hit analyze, and watch each URL report back as it completes. Polite
          rate-limiting, automatic retries, nothing to refresh.
        </p>

        <div className="mt-9">
          <AnalyzeForm />
        </div>

        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-stone-400">
          {META.map((m, i) => (
            <span key={m} className="flex items-center gap-3">
              {i > 0 && <span className="text-stone-300" aria-hidden>·</span>}
              {m}
            </span>
          ))}
        </p>
      </section>

      <section className="mt-16">
        <h2 className="text-sm font-bold uppercase tracking-wider text-stone-400">How it works</h2>
        <div className="mt-4 border-t border-stone-200">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="grid gap-1 border-b border-stone-200 py-5 sm:grid-cols-[3rem_12rem_1fr] sm:gap-6"
            >
              <span className="font-mono text-sm text-stone-400">{s.n}</span>
              <h3 className="text-[15px] font-bold text-stone-900">{s.title}</h3>
              <p className="text-sm leading-relaxed text-stone-500">{s.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
