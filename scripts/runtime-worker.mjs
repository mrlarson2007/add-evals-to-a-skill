import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClaudeHooks } from './runtime-isolation.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
try {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const { evaluate, cache, TestSuiteConfigSchema } = await import('promptfoo');
  cache.disableCache();
  TestSuiteConfigSchema.parse(input.config);
  const isolationEvents = [];
  let claudeBoundaryConfigured = false;
  for (const provider of input.config.providers) {
    if (provider.id !== 'anthropic:claude-agent-sdk') continue;
    provider.config.hooks = createClaudeHooks(input.workspace, {
      skillEnabled: provider.config.skills?.includes('review-code') === true,
      onObservation: async (event) => {
        isolationEvents.push(event);
        await appendFile(path.join(path.dirname(outputPath), 'boundary-events.jsonl'), `${JSON.stringify(event)}\n`);
      },
    });
    provider.config.setting_sources = ['project'];
    claudeBoundaryConfigured = true;
  }
  let cliVersion = null;
  if (input.config.providers[0].id === 'openai:codex-sdk' && process.platform !== 'win32') {
    try {
      cliVersion = execFileSync(fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url)),
        ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { /* Missing runtime version evidence stays null. */ }
  }
  const evaluation = await evaluate(input.config, {
    ...input.config.evaluateOptions, cache: false, maxConcurrency: 1, repeat: 1,
  });
  const report = await evaluation.toEvaluateSummary();
  await writeFile(path.join(path.dirname(outputPath), 'promptfoo-report.json'), JSON.stringify(report, null, 2));
  const results = await evaluation.getResults();
  const first = results[0];
  const response = { ...(first?.response ?? { error: first?.error ?? 'Promptfoo produced no provider response' }) };
  const toolCalls = response.metadata?.toolCalls;
  const guarded = new Map(isolationEvents.map((event) => [event.toolUseId, event.toolName]));
  response.metadata = {
    ...response.metadata, harnessRuntime: { cliVersion },
    ...(claudeBoundaryConfigured ? { harnessIsolation: {
      configured: true, kind: 'mandatory-native-PreToolUse',
      toolCoverageVerified: !response.error && Array.isArray(toolCalls)
        && toolCalls.every((call) => typeof call.id === 'string' && guarded.get(call.id) === call.name),
      events: isolationEvents,
    } } : {}),
    promptfoo: {
      success: first?.success ?? false, score: first?.score ?? null,
      gradingResult: first?.gradingResult ?? null, error: first?.error ?? null,
    },
  };
  await writeFile(outputPath, JSON.stringify(response, null, 2));
} catch (error) {
  await writeFile(outputPath, JSON.stringify({ error: String(error), stack: error.stack }));
  await appendFile(`${outputPath}.error`, `${error.stack}\n`);
  process.exitCode = 1;
}
