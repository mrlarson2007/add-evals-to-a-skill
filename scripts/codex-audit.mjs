import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const mutationCommands = new Set([
  'apply_patch', 'touch', 'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'tee', 'truncate',
  'install', 'chmod', 'chown', 'chgrp', 'ln', 'dd',
]);

// This deliberately is not a general shell parser. Unsupported syntax stays
// unknown rather than being inferred safe from an unchanged filesystem.
function words(command) {
  const result = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of command) {
    if (/[\r\n\0]/.test(character)) return { unknown: true };
    if (quote) {
      if (character === quote) { quote = ''; continue; }
      if (quote === '"' && /[$`\\]/.test(character)) return { unknown: true };
      word += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (character === '>') return { unknown: true, mutation: true };
    if (/[;&|<(){}*?[\]~$`\\#]/.test(character)) return { unknown: true };
    if (/\s/.test(character)) {
      if (started) result.push(word);
      word = ''; started = false;
    } else { word += character; started = true; }
  }
  if (quote) return { unknown: true };
  if (started) result.push(word);
  return { tokens: result };
}

export function classifyCodexCommand(command) {
  if (typeof command !== 'string') return { readOnly: false, mutation: false };
  let parsed = words(command);
  if (!parsed.tokens) return { readOnly: false, mutation: parsed.mutation === true };
  let tokens = parsed.tokens;
  if (['/bin/bash', '/bin/sh', 'bash', 'sh'].includes(tokens[0])) {
    if (tokens.length !== 3 || !['-c', '-lc'].includes(tokens[1])) return { readOnly: false, mutation: false };
    parsed = words(tokens[2]);
    if (!parsed.tokens) return { readOnly: false, mutation: parsed.mutation === true };
    tokens = parsed.tokens;
  }
  const [executable, ...args] = tokens;
  const name = executable?.replace(/^\/(?:usr\/)?bin\//, '');
  if (mutationCommands.has(name)) return { readOnly: false, mutation: true };
  if (!executable || (executable.includes('/') && !/^\/(?:usr\/)?bin\/[a-z]+$/.test(executable))) {
    return { readOnly: false, mutation: false };
  }
  if (name === 'cat') {
    const paths = args[0] === '--' ? args.slice(1) : args;
    return { readOnly: paths.length > 0 && paths.every((file) => file !== '-' && !file.startsWith('-')), mutation: false, readPaths: paths, exactRead: true };
  }
  if (name === 'pwd') return { readOnly: args.length === 0, mutation: false };
  if (name === 'ls') {
    return { readOnly: args.every((arg) => !arg.startsWith('-') || /^-[alhdR]+$/.test(arg) || arg === '--'), mutation: false };
  }
  if (name === 'sed') {
    return { readOnly: args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] ?? '')
      && args.length > 2 && args.slice(2).every((arg) => !arg.startsWith('-')),
    mutation: false, readPaths: args.slice(2), exactRead: false };
  }
  // Only inert search flags are admitted; rg --pre/--hostname-bin can execute
  // programs, so accepting arbitrary "search" options would not be read-only.
  if (name === 'rg' || name === 'grep') {
    const safeFlags = name === 'rg'
      ? new Set(['-n', '-i', '-l', '-F', '-e', '-g', '--hidden', '--files', '--glob', '--line-number'])
      : new Set(['-n', '-i', '-l', '-F', '-E', '-r', '-R', '-H', '-I', '-e']);
    let literalNext = false;
    let optionsEnded = false;
    for (const arg of args) {
      if (literalNext) { literalNext = false; continue; }
      if (!optionsEnded && arg === '--') { optionsEnded = true; continue; }
      if (!optionsEnded && arg.startsWith('-')) {
        if (!safeFlags.has(arg)) return { readOnly: false, mutation: false };
        literalNext = ['-e', '-g', '--glob'].includes(arg);
      }
    }
    return {
      readOnly: args.length > 0 && !literalNext, mutation: false,
      readPaths: args, exactRead: false, activationInspectable: false,
    };
  }
  return { readOnly: false, mutation: false };
}

async function containsSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && await containsSymlink(path.join(directory, entry.name))) return true;
  }
  return false;
}

export async function prepareCodexAudit(workspace) {
  const root = await realpath(workspace);
  const skillPath = path.join(root, '.agents/skills/review-code/SKILL.md');
  const symlinksPresent = await containsSymlink(root);
  try {
    if (await realpath(skillPath) !== skillPath) throw new Error('Skill audit requires a regular installed artifact, not a symlink');
    return { workspace: root, skillPath, symlinksPresent, skillInstalled: true, skillDigest: digest(await readFile(skillPath)) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { workspace: root, skillPath, symlinksPresent, skillInstalled: false };
  }
}

export function auditCodexTranscript(response, prepared, isolationVerified) {
  let raw;
  try { raw = typeof response.raw === 'string' ? JSON.parse(response.raw) : response.raw; } catch { /* Unknown stays unverified. */ }
  const complete = !response.error && Array.isArray(raw?.items)
    && Number.isFinite(raw?.usage?.input_tokens) && Number.isFinite(raw?.usage?.output_tokens);
  const items = complete ? raw.items : [];
  let covered = complete && isolationVerified === true;
  let activationCovered = prepared.symlinksPresent !== true;
  let commandCount = 0;
  let unknownCommandCount = 0;
  let writeAttemptCount = 0;
  let skillReadCount = 0;
  let skillReadAttemptCount = 0;
  for (const item of items) {
    if (item?.type === 'command_execution') {
      commandCount++;
      const classification = classifyCodexCommand(item.command);
      if (classification.mutation) writeAttemptCount++;
      if (!classification.readOnly) { unknownCommandCount++; covered = false; }
      if (classification.activationInspectable === false) activationCovered = false;
      if (!['completed', 'failed'].includes(item.status) || !Number.isInteger(item.exit_code)) covered = false;
      const paths = (classification.readPaths ?? []).map((file) => path.resolve(prepared.workspace, file));
      if (paths.includes(prepared.skillPath)) skillReadAttemptCount++;
      if (classification.readOnly && classification.exactRead === true && paths.length === 1 && paths[0] === prepared.skillPath
        && prepared.skillInstalled && item.exit_code === 0 && item.status === 'completed'
        && typeof item.aggregated_output === 'string' && digest(item.aggregated_output) === prepared.skillDigest) {
        skillReadCount++;
      }
    } else if (!['agent_message', 'reasoning', 'file_change'].includes(item?.type)) {
      covered = false;
    }
  }
  return {
    kind: 'strict-native-command-audit', completeNativeTurn: complete,
    commandCount, unknownCommandCount, writeAttemptCount,
    writeAttemptTraceAvailable: covered, activationTraceAvailable: covered && activationCovered,
    skillInstalled: prepared.skillInstalled, skillReadCount, skillReadAttemptCount,
    // Exact artifact consumption is still a heuristic for activation, never a
    // fabricated native Skill invocation event.
    activationEvidenceKind: 'heuristic-skill-read',
    nativeSkillInvocationObserved: false,
    verifiedSkillRead: covered && skillReadCount > 0,
    limitation: 'Only a narrow literal read-only shell grammar is covered. Unknown tools, scripts, options, expansions, and compound commands remain unverified. Searches and symlink aliases cannot establish nonactivation; filesystem immutability is not absence-of-attempt evidence.',
  };
}
