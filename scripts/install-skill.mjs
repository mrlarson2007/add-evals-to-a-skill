import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../skills/add-skill-evals/', import.meta.url));
const locations = {
  codex: '.agents/skills/add-skill-evals',
  claude: '.claude/skills/add-skill-evals',
  copilot: '.github/skills/add-skill-evals',
};

export function parseArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || key in args) {
      throw new Error(`Expected ${allowed.join(' and ')} with explicit values`);
    }
    args[key] = argv[i + 1];
  }
  if (allowed.some((key) => !args[key])) throw new Error(`Required: ${allowed.join(' and ')}`);
  return args;
}

export function assertNoSymlinks(target) {
  const absolute = resolve(target);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path forbidden: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function files(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return files(root, name);
    if (!entry.isFile()) throw new Error(`Only regular files/directories supported: ${name}`);
    return [name];
  }).sort();
}

export function verifyCopy(from, to) {
  assertNoSymlinks(to);
  const expected = files(from);
  const actual = files(to);
  if (JSON.stringify(expected) !== JSON.stringify(actual) ||
      expected.some((name) => !readFileSync(join(from, name)).equals(readFileSync(join(to, name))))) {
    throw new Error(`Existing destination differs from canonical bytes: ${to}`);
  }
}

export function copyNew(from, to) {
  assertNoSymlinks(to);
  const names = files(from);
  mkdirSync(dirname(to), { recursive: true });
  mkdirSync(to);
  try {
    for (const name of names) {
      mkdirSync(dirname(join(to, name)), { recursive: true });
      copyFileSync(join(from, name), join(to, name), constants.COPYFILE_EXCL);
    }
    verifyCopy(from, to);
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
}

export function installSkill(runtime, destination) {
  if (!Object.hasOwn(locations, runtime)) throw new Error('Runtime must be codex, claude, or copilot');
  const root = resolve(destination);
  assertNoSymlinks(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory() ||
      realpathSync(root) === realpathSync(homedir())) {
    throw new Error('Destination must be an existing repository root, not a home directory');
  }
  const git = join(root, '.git');
  assertNoSymlinks(git);
  if (!existsSync(git) || !(lstatSync(git).isDirectory() || lstatSync(git).isFile())) {
    throw new Error('Destination must contain .git (directory or worktree file)');
  }
  const target = join(root, locations[runtime]);
  for (const location of Object.values(locations)) {
    const candidate = join(root, location);
    assertNoSymlinks(candidate);
    if (candidate !== target && existsSync(candidate)) {
      throw new Error(`Conflicting installation: ${candidate}; keep only one runtime copy`);
    }
  }
  if (existsSync(target)) verifyCopy(source, target);
  else copyNew(source, target);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
      console.log(
        'Usage: node scripts/install-skill.mjs --runtime codex|claude|copilot --dest /absolute/repo\n' +
        'Copy the canonical skill into an existing repository, never personal directories.\n' +
        'Codex: .agents/skills; Claude: .claude/skills; Copilot: .github/skills.\n' +
        'Refuses symlinks, conflicting installations, or different existing bytes.',
      );
    } else {
      const args = parseArgs(process.argv.slice(2), ['--runtime', '--dest']);
      console.log(`Verified canonical skill bytes at ${installSkill(args['--runtime'], args['--dest'])}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
