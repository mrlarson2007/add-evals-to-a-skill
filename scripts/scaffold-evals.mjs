import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNew, parseArgs } from './install-skill.mjs';

try {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log(
      'Usage: node scripts/scaffold-evals.mjs --dest ./evals/new-suite\n' +
      'Copy the offline artifact example into a new directory; never overwrite.\n' +
      'Run node run.mjs from that directory. This does not invoke an agent.',
    );
  } else {
    const args = parseArgs(process.argv.slice(2), ['--dest']);
    const source = fileURLToPath(new URL('../skills/add-skill-evals/assets/promptfoo/', import.meta.url));
    const destination = resolve(args['--dest']);
    copyNew(source, destination);
    console.log(`Created offline artifact example at ${destination}; run node run.mjs there`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
