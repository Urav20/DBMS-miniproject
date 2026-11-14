import { SIZES } from "../config.mjs";
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[(i += 1)];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
export function sizeArg(args) {
  const size = Number(args.size);
  if (!SIZES.includes(size)) {
    console.error(`Usage: --size ${SIZES.join("|")}`);
    process.exit(2);
  }
  return size;
}
export const fail = (err) => {
  console.error(`\nERROR: ${err?.message ?? err}`);
  process.exit(1);
};
