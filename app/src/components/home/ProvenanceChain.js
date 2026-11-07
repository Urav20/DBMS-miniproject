// The five stages of an evidence record's history, in the order they happen.
const steps = [
  { title: "Collected", text: "Who collected it, when, where and by what method." },
  { title: "In custody", text: "Each handover between people, in order, with the reason." },
  { title: "Analysed", text: "Which tool and which analyst examined it." },
  { title: "Findings", text: "What the analysis concluded about it." },
  { title: "Linked", text: "Relationships an analyst recorded, with a written reason." },
];

export default function ProvenanceChain() {
  return (
    <ol className="grid gap-8 lg:grid-cols-5 lg:gap-6">
      {steps.map((step, index) => (
        <li key={step.title} className="relative pl-12 lg:pl-0 lg:pt-12">
          {index < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute -bottom-8 left-[13px] top-7 w-px bg-line-strong lg:-right-6 lg:bottom-auto lg:left-7 lg:top-[13px] lg:h-px lg:w-auto"
            />
          )}
          <span className="absolute left-0 top-0 grid size-7 place-items-center rounded-sm bg-marker text-sm font-semibold text-ink">
            {index + 1}
          </span>
          <h3 className="text-base font-semibold">{step.title}</h3>
          <p className="mt-1 max-w-xs text-sm leading-6 text-ink-soft">
            {step.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
