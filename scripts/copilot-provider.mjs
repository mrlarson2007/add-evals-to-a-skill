import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const READ_ONLY_TOOLS = ['view', 'glob', 'grep', 'skill'];

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
      return {
        output: response?.data?.content ?? '',
        metadata: { sessionId: session.sessionId, events },
      };
    } catch (error) {
      return { error: String(error), metadata: { events } };
    } finally {
      if (session) await session.disconnect().catch(() => {});
      await client.stop().catch(() => {});
    }
  }
}
