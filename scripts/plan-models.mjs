import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseArgs as parseRunArgs } from './run-example.mjs';

const cases = JSON.parse(readFileSync(new URL('../examples/review-code/evals/cases.json', import.meta.url), 'utf8'));

export function planModels(argv) {
  const models = {};
  const runArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--claude', '--openai', '--gemini'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--') || models[arg]) throw new Error(`Provide one exact model ID for ${arg}`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) throw new Error('Model IDs must be literal identifiers, not shell expressions');
      models[arg] = value;
    } else if (['--repeat', '--variant', '--case', '--timeout'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      runArgs.push(arg, value);
    } else if (arg === '--no-skill') runArgs.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (Object.keys(models).length !== 3) throw new Error('Select exact available IDs with --claude ID --openai ID --gemini ID');
  if (new Set(Object.values(models)).size !== 3) throw new Error('Select three distinct model IDs');
  const options = parseRunArgs(['--runtime', 'copilot', '--repeat', '3', ...runArgs]);
  if (options.case && !cases.some((item) => item.id === options.case)) throw new Error('Unknown example case');
  const selectedCases = cases.filter((item) => !options.case || options.case === item.id).map((item) => item.id);
  const perModel = selectedCases.length * options.variants.length * options.repeat;
  return {
    runtime: 'copilot',
    repeat: options.repeat,
    variants: options.variants,
    cases: selectedCases,
    callsPerModel: perModel,
    plannedProviderInvocations: perModel * 3,
    executesModels: false,
    availability: 'Unverified by planning. Confirm exact IDs using the Copilot CLI model picker on your machine.',
    limitation: 'Each provider invocation is an agent trial and may make multiple model calls. Cost is unknown, not zero.',
    profiles: Object.entries(models).map(([flag, id]) => ({
      family: flag.slice(2), model: id, runtime: 'copilot', plannedTrials: perModel,
      // JSON escaping is not shell escaping; all generated tokens are validated literals.
      command: ['npm', 'run', 'eval:example', '--', '--runtime', 'copilot', '--model', id,
        '--repeat', String(options.repeat), '--variant', options.variants.join(','),
        '--timeout', String(options.timeout), ...(options.case ? ['--case', options.case] : [])].join(' '),
    })),
  };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: npm run eval:models -- --claude ID --openai ID --gemini ID [--repeat N] [--variant current,proposed] [--case R1] [--timeout MS] [--no-skill]\n' +
      'Plans three separate Copilot CLI/SDK profiles and prints commands; never runs models.\n' +
      'First confirm exact available IDs in your Copilot CLI model picker. No versions are guessed.');
    return;
  }
  console.log(JSON.stringify(planModels(argv), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
