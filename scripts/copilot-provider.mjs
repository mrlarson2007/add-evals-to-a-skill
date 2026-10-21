import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Promptfoo custom provider backed by the official SDK, not a model API substitute.
export default class CopilotProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() { return 'github:copilot-sdk'; }

  async callApi(prompt) {
    const { CopilotClient } = await import('@github/copilot-sdk');
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
        availableTools: ['view', 'glob', 'grep', 'skill'],
        onPermissionRequest: async (request) => {
          let withinWorkspace = false;
          if (request.kind === 'read' && typeof request.path === 'string') {
            try {
              const resolved = await realpath(path.resolve(this.config.working_dir, request.path));
              const relative = path.relative(this.config.working_dir, resolved);
              withinWorkspace = !path.isAbsolute(relative) && relative !== '..'
                && !relative.startsWith(`..${path.sep}`);
            } catch { /* Missing or unresolvable paths do not receive read permission. */ }
          }
          const result = withinWorkspace
            ? { kind: 'approve-once' }
            : { kind: 'reject', feedback: 'Only reads within the evaluation workspace are permitted.' };
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
