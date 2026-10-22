import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const denied = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });
const allowed = () => ({ permissionDecision: 'allow' });

async function containedPath(root, candidate) {
  const resolved = await realpath(path.resolve(root, candidate));
  const relative = path.relative(root, resolved);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Path escapes the evaluation workspace');
  }
  return resolved;
}

async function checkRecursiveTarget(target) {
  const stat = await lstat(target);
  if (!stat.isDirectory()) return;
  for (const name of await readdir(target)) {
    const entry = path.join(target, name);
    const entryStat = await lstat(entry);
    if (entryStat.isSymbolicLink()) {
      // Do not depend on native search tools' differing symlink-follow behavior.
      throw new Error('Recursive inspection of symlink-containing trees is not permitted');
    }
    if (entryStat.isDirectory()) await checkRecursiveTarget(entry);
  }
}

export async function claudeToolPermission(workspace, input, { skillEnabled = false } = {}) {
  try {
    if (input.hook_event_name !== 'PreToolUse') return denied('Unexpected hook event');
    const root = await realpath(workspace);
    const cwd = input.cwd === undefined ? root : await containedPath(root, input.cwd);
    const args = input.tool_input;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return denied('Ambiguous tool input');
    if (input.tool_name === 'Skill') {
      if (!skillEnabled || args.skill !== 'review-code') return denied('Only the installed review-code skill is permitted');
      await containedPath(root, '.claude/skills/review-code/SKILL.md');
      return allowed();
    }
    if (input.tool_name === 'Read') {
      if (typeof args.file_path !== 'string' || !args.file_path.trim()) return denied('Read requires file_path');
      await containedPath(root, path.resolve(cwd, args.file_path));
      return allowed();
    }
    if (input.tool_name === 'Grep' || input.tool_name === 'Glob') {
      if (args.path !== undefined && (typeof args.path !== 'string' || !args.path.trim())) {
        return denied('Search path is ambiguous');
      }
      if (input.tool_name === 'Glob' && (typeof args.pattern !== 'string'
        || path.isAbsolute(args.pattern) || path.win32.isAbsolute(args.pattern)
        || args.pattern.includes('..') || args.pattern.includes('\\') || args.pattern.startsWith('~'))) {
        return denied('Glob patterns must not escape the supplied search path');
      }
      const target = await containedPath(root, path.resolve(cwd, args.path ?? '.'));
      await checkRecursiveTarget(target);
      return allowed();
    }
    return denied('Only workspace Read, Grep, Glob, and the installed review-code Skill are permitted');
  } catch (error) {
    return denied(`Read boundary could not be established: ${error.message}`);
  }
}

export function createClaudeHooks(workspace, options = {}) {
  return {
    PreToolUse: [{
      hooks: [async (input, toolUseId) => {
        let decision = await claudeToolPermission(workspace, input, options);
        const event = {
          type: 'harness.claude.pre_tool', toolName: input.tool_name,
          input: input.tool_input, toolUseId: toolUseId ?? input.tool_use_id ?? null,
          decision,
        };
        try {
          await options.onObservation?.(event);
        } catch {
          decision = denied('Unable to retain mandatory boundary observation');
          event.decision = decision;
        }
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } };
      }],
    }],
  };
}

export function readIsolation(runtime, response) {
  if (runtime === 'codex') {
    const evidence = response.metadata?.harnessIsolation;
    const available = evidence?.kind === 'docker-native-codex' && evidence.configured === true;
    const verified = available && !response.error
      && evidence.filesystem === 'empty-root-explicit-readonly-mounts'
      && evidence.network === 'none-with-model-only-unix-relay'
      && evidence.freshHome === true && Number.isSafeInteger(evidence.nativeLaunches) && evidence.nativeLaunches > 0
      && ['verified', 'readDenied', 'writeDenied', 'hostWriteDenied', 'networkDenied',
        'networkNamespaceOnlyLoopback', 'relayReachable', 'relayDeniesOtherPaths']
        .every((name) => evidence.probe?.[name] === true);
    return {
      available, verified,
      reason: verified
        ? 'Native Codex ran in a probed empty-root Docker read/write boundary with no external network and a model-only relay'
        : 'Codex read-only mode does not confine reads. Opt-in Docker boundary, successful enforcement probes, and a native runtime completion are required.',
    };
  }
  if (runtime === 'claude') {
    const evidence = response.metadata?.harnessIsolation;
    return {
      available: evidence?.configured === true,
      verified: evidence?.toolCoverageVerified === true,
      reason: evidence?.toolCoverageVerified
        ? 'Mandatory native PreToolUse boundary covered every reported tool call'
        : 'Mandatory PreToolUse configuration or complete native tool coverage is unverified',
    };
  }
  const events = response.metadata?.events ?? [];
  return {
    available: true,
    verified: events.some((event) => event.type === 'harness.permission' && event.request?.kind === 'read')
      && events.some((event) => event.type === 'session.idle'),
    reason: 'Canonical workspace read-permission callback; runtime remains a tool boundary, not a complete operating-system sandbox',
  };
}
