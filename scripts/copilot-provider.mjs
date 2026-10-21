import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const READ_ONLY_TOOLS = ['view', 'glob', 'grep', 'skill'];

export function summarizeCopilotUsage(events) {
  const raw = events.filter((event) => event.type === 'assistant.usage');
  const calls = new Map();
  raw.forEach((event, index) => {
    const data = event.data ?? {};
    const key = data.accounting?.usageId
      ? `${data.accounting.sourceSessionId ?? ''}:${data.accounting.usageId}`
      : data.apiCallId ?? event.id ?? `unkeyed-${index}`;
    calls.set(key, data);
  });
  const values = [...calls.values()];
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
  const observedFieldCounts = {};
  const totals = {};
  for (const field of fields) {
    const observed = values.map((data) => data[field])
      .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    observedFieldCounts[field] = observed.length;
    totals[field] = observed.length ? observed.reduce((sum, value) => sum + value, 0) : null;
  }
  const completeInputOutput = values.length > 0
    && observedFieldCounts.inputTokens === values.length && observedFieldCounts.outputTokens === values.length;
  const tokenUsage = completeInputOutput ? {
    prompt: totals.inputTokens, completion: totals.outputTokens,
    total: totals.inputTokens + totals.outputTokens, numRequests: values.length,
    ...(observedFieldCounts.cacheReadTokens === values.length ? { cached: totals.cacheReadTokens } : {}),
  } : null;
  return {
    tokenUsage,
    reportedUsage: {
      source: 'assistant.usage', rawEventCount: raw.length, accountedCalls: values.length,
      ...totals, observedFieldCounts,
      reportedBillingCostValues: values.map((data) => data.cost)
        .filter((value) => typeof value === 'number' && Number.isFinite(value)),
      monetaryCostUsd: null,
      billingUnitLimitation: 'SDK cost is a model-multiplier billing value, not USD. Currency conversion and subscription allocation are unknown, not zero.',
      coverage: 'Sums cover observed events only; missing fields remain null. Latest event per usageId/apiCallId/event id is retained; unkeyed events are distinct.',
      tokenNormalization: 'Prompt/completion are reported input/output sums. Cache counters are retained separately and are not added again.',
    },
  };
}

export async function workspaceReadPermission(workspace, request) {
  if (request.kind === 'read' && !request.managedApprovalRequired && !request.requestSandboxBypass
      && typeof request.path === 'string' && request.path.trim()) {
    try {
      const root = await realpath(workspace);
      const resolved = await realpath(path.resolve(root, request.path));
      const relative = path.relative(root, resolved);
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        return { kind: 'approve-once' };
      }
    } catch { /* Missing or unresolvable paths do not receive read permission. */ }
  }
  return { kind: 'reject', feedback: 'Only reads within the evaluation workspace are permitted.' };
}

// Promptfoo custom provider backed by the official SDK, not a model API substitute.
export default class CopilotProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() { return 'github:copilot-sdk'; }

  async callApi(prompt) {
    const { CopilotClient, ToolSet } = await import('@github/copilot-sdk');
    const client = new CopilotClient({
      workingDirectory: this.config.working_dir,
      baseDirectory: this.config.state_dir,
      logLevel: 'error',
    });
    let session;
    let result;
    const events = [];
    const record = async (event) => {
      events.push(event);
      if (this.config.trace_file) {
        await appendFile(this.config.trace_file, `${JSON.stringify(event)}\n`);
      }
    };
    try {
      session = await client.createSession({
        ...(this.config.model ? { model: this.config.model } : {}),
        workingDirectory: this.config.working_dir,
        configDirectory: this.config.state_dir,
        enableConfigDiscovery: false,
        skillDirectories: this.config.skill_directories ?? [],
        availableTools: new ToolSet().addBuiltIn(READ_ONLY_TOOLS),
        onPermissionRequest: async (request) => {
          const result = await workspaceReadPermission(this.config.working_dir, request);
          await record({ type: 'harness.permission', request, result });
          return result;
        },
      });
      session.on((event) => { void record(event).catch(() => {}); });
      const response = await session.sendAndWait({ prompt }, this.config.timeout_ms);
      result = {
        output: response?.data?.content ?? '',
        metadata: { sessionId: session.sessionId, events },
      };
    } catch (error) {
      result = { error: String(error), metadata: { events } };
    } finally {
      if (session) await session.disconnect().catch(() => {});
      await client.stop().catch(() => {});
    }
    const usage = summarizeCopilotUsage(events);
    return {
      ...result, ...(usage.tokenUsage ? { tokenUsage: usage.tokenUsage } : {}),
      metadata: { ...result.metadata, reportedUsage: usage.reportedUsage },
    };
  }
}
