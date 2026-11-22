// Driver for this entry: reads every case from /input/cases.json, answers each
// one alone with run() from solve.js, and writes /output/answers.json with the
// answers in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js loads, so the whole build
// runs under the same flag the house baseline is timed with.
setFlagsFromString('--no-incremental-marking');

type Solver = { run: (input: unknown) => unknown };
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as Solver;

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];
const answers = cases.map((c) => run(c.input));
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
