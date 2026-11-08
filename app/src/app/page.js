import Link from "next/link";
import BrandMark from "@/components/layout/BrandMark";
import ProvenanceChain from "@/components/home/ProvenanceChain";

const principles = [
  {
    title: "MySQL is the record",
    text: "Cases, evidence, custody history, analyses and the audit log live in MySQL. It decides who may see what.",
  },
  {
    title: "Qdrant suggests leads",
    text: "Vector search ranks evidence by similarity of meaning. A high score is something to check, never proof.",
  },
  {
    title: "Analysts decide links",
    text: "A relationship between two evidence items is recorded by a person, with a written reason.",
  },
];

export default function HomePage() {
  return (
    <>
      <div className="bg-night text-white">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <header className="flex items-center justify-between py-5">
            <Link href="/" className="rounded-sm outline-offset-4 focus-visible:outline-white">
              <BrandMark />
            </Link>
            <Link
              href="/dashboard"
              className="rounded-sm border border-night-line px-4 py-2 text-sm font-medium text-night-text hover:border-night-dim hover:text-white focus-visible:outline-white"
            >
              Open dashboard
            </Link>
          </header>

          <section className="py-16 sm:py-24 lg:py-28">
            <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl lg:leading-[1.05]">
              Evidence you can trace back to its source.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-night-text">
              TRACE-X keeps the full history of every digital evidence item:
              who collected it, who held it, and what was found. Semantic search
              points investigators to leads. Only an analyst can record that two
              items are related.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link
                href="/dashboard"
                className="rounded-sm bg-accent px-5 py-3 font-medium text-white hover:bg-accent-deep focus-visible:outline-white"
              >
                Open dashboard
              </Link>
              <a
                href="#provenance"
                className="rounded-sm border border-night-line px-5 py-3 font-medium text-night-text hover:border-night-dim hover:text-white focus-visible:outline-white"
              >
                See what each record carries
              </a>
            </div>
          </section>
        </div>
      </div>

      <main>
        <section
          id="provenance"
          aria-labelledby="provenance-heading"
          className="mx-auto max-w-6xl scroll-mt-4 px-5 py-16 sm:px-8 sm:py-20"
        >
          <h2
            id="provenance-heading"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            The trail behind every item
          </h2>
          <p className="mt-3 max-w-2xl text-ink-soft">
            TRACE-X is designed so that each evidence record keeps its full
            history in MySQL, from collection to the findings that cite it.
          </p>
          <div className="mt-10">
            <ProvenanceChain />
          </div>
        </section>

        <section
          aria-labelledby="principles-heading"
          className="border-t border-line bg-panel"
        >
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <h2
              id="principles-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              How the work is divided
            </h2>
            <div className="mt-10 grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
              {principles.map((item) => (
                <div
                  key={item.title}
                  className="py-6 first:pt-0 md:px-6 md:py-0 md:first:pl-0 md:last:pr-0"
                >
                  <h3 className="text-base font-semibold">{item.title}</h3>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-ink-soft">
                    {item.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <p className="mx-auto max-w-6xl px-5 py-6 text-sm text-ink-soft sm:px-8">
          TRACE-X is a DBMS course project. Demonstration data will be fictional.
        </p>
      </footer>
    </>
  );
}
