import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClaudeHooks, readIsolation } from './runtime-isolation.mjs';
import { createCodexIsolation, findCodexExecutable, probeCodexIsolation } from './codex-isolation.mjs';
import { auditCodexTranscript, prepareCodexAudit } from './codex-audit.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
let codexBoundary;
try {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const { evaluate, cache, TestSuiteConfigSchema } = await import('promptfoo');
  cache.disableCache();
  TestSuiteConfigSchema.parse(input.config);
  const isolationEvents = [];
  let claudeBoundaryConfigured = false;
  let codexProbe;
  let codexAudit;
  if (process.env.EVAL_CODEX_ISOLATION && process.env.EVAL_CODEX_ISOLATION !== 'docker') {
    throw new Error('Unsupported EVAL_CODEX_ISOLATION; only the enforced docker profile is supported');
  }
  for (const provider of input.config.providers) {
    if (provider.id === 'openai:codex-sdk' && process.env.EVAL_CODEX_ISOLATION === 'docker') {
      if (codexBoundary) throw new Error('Codex isolation requires a single fresh native provider');
      codexBoundary = await createCodexIsolation({
        workspace: input.workspace, artifactDir: path.dirname(outputPath),
        executable: await findCodexExecutable(),
        apiKey: provider.config.apiKey ?? process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
      });
      codexProbe = await probeCodexIsolation(codexBoundary, inputPath);
      if (!codexProbe.verified) throw new Error('Codex operating-system isolation probe failed closed');
      codexAudit = await prepareCodexAudit(input.workspace);
      const schemaDirectory = path.join(path.dirname(codexBoundary.wrapper), 'schemas');
      await mkdir(schemaDirectory, { mode: 0o700 });
      process.env.TMPDIR = schemaDirectory;
      Object.assign(provider.config, {
        codex_path_override: codexBoundary.wrapper,
        base_url: 'http://127.0.0.1:43127/v1', apiKey: 'isolated-relay',
        working_dir: input.workspace, copy_working_dir: false,
        persist_threads: false, thread_id: undefined, inherit_process_env: false, cli_env: {},
        additional_directories: [], approval_policy: 'never',
        cli_config: {
          model_provider: 'isolated_openai',
          shell_environment_policy: {
            inherit: 'none',
            set: { PATH: '/runtime/bin:/bin', HOME: '/home/codex', TMPDIR: '/scratch', CODEX_HOME: '/home/codex' },
          },
          features: { shell_snapshot: false },
          model_providers: { isolated_openai: {
            name: 'Isolated OpenAI relay', base_url: 'http://127.0.0.1:43127/v1',
            wire_api: 'responses', env_key: 'CODEX_API_KEY', supports_websockets: false,
          } },
        },
        // The tested outer OS boundary replaces the CLI's write-only sandbox.
        sandbox_mode: 'danger-full-access', web_search_mode: 'disabled',
      });
    }
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
  const codexIsolation = codexBoundary ? {
    ...await codexBoundary.evidence(), probe: codexProbe,
    profile: 'docker', nativeSandboxMode: input.config.providers[0].config.sandbox_mode,
    workspaceMount: 'read-only', apiAuthentication: 'host-relay',
  } : null;
  const codexAuditEvidence = codexIsolation ? auditCodexTranscript(response, codexAudit,
    readIsolation('codex', { ...response, metadata: { harnessIsolation: codexIsolation } }).verified) : null;
  response.metadata = {
    ...response.metadata, harnessRuntime: { cliVersion },
    ...(codexBoundary ? { harnessIsolation: codexIsolation, harnessCodexAudit: codexAuditEvidence } : {}),
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
} finally {
  await codexBoundary?.cleanup();
}
