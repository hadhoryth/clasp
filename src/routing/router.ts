import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '../config.js';
import { BridgeError } from '../errors.js';
import type { Model } from '../codex/catalog.js';
import { systemText, type AnthropicRequest } from '../gateway/anthropic.js';
export type Role = 'main' | 'subagent' | 'classifier' | 'compact' | 'background';
export interface Route {
  role: Role;
  requested: string;
  model: Model;
  effort?: string;
  fallbackFrom?: string;
}
export function detectRole(request: AnthropicRequest, headers: IncomingHttpHeaders = {}): Role {
  // Only request-envelope metadata and system instructions; never scan user/tool text for routing.
  const hint =
    headers['x-claude-codex-role'] ??
    request.metadata?.request_type ??
    request.metadata?.query_source;
  if (typeof hint === 'string') {
    if (/^(classifier|auto_mode)$/.test(hint)) return 'classifier';
    if (/^(compact|compaction|summarize)$/.test(hint)) return 'compact';
    if (/^(subagent|explore|plan_agent)$/.test(hint)) return 'subagent';
    if (hint === 'background') return 'background';
  }
  const system = systemText(request);
  if (
    !request.tools?.length &&
    (/auto.mode.*classifier|permission.*classifier|classify.*tool.*(safe|permission)/is.test(
      system,
    ) ||
      (/<block>|<severity>/.test(system) && /SOFT BLOCK|HARD BLOCK|tool call|action/i.test(system)))
  )
    return 'classifier';
  if (
    /(?:^|\n)(?:Your task is to (?:create a detailed summary of|summarize) the conversation|You are (?:a helpful AI assistant |an assistant )?(?:tasked with |that )summariz(?:ing|es) (?:the )?conversations?)/i.test(
      system,
    )
  )
    return 'compact';
  if (
    headers['x-claude-code-agent-id'] ||
    headers['x-claude-code-parent-agent-id'] ||
    request.metadata?.agent_id
  )
    return 'subagent';
  if (
    /you are (a file search specialist|an? (explore|plan) agent)|read-only exploration/i.test(
      system,
    )
  )
    return 'subagent';
  return 'main';
}
export class Router {
  constructor(
    readonly config: Config,
    readonly models: Model[],
    readonly defaultModel: string,
    private log: (line: string) => void = () => {},
  ) {}
  resolve(id: string): { model: Model; fallbackFrom?: string } {
    const found = this.models.find((m) => m.id === id && m.available);
    if (found) return { model: found };
    for (const alternative of Object.hasOwn(this.config.fallback, id)
      ? this.config.fallback[id]!
      : []) {
      const model = this.models.find((m) => m.id === alternative && m.available);
      if (model) {
        this.log(`${id} unavailable; using configured fallback ${alternative}`);
        return { model, fallbackFrom: id };
      }
    }
    const available = this.models
      .filter((m) => m.available && !m.hidden)
      .map((m) => m.id)
      .join(', ');
    throw new BridgeError(
      `${/^[\w.\-/\[\]]{1,160}$/.test(id) ? id : 'Requested model'} is not available through your Codex account. Available: ${available}. Run clasp models --refresh.`,
      400,
    );
  }
  route(request: AnthropicRequest, headers: IncomingHttpHeaders = {}): Route {
    const role = detectRole(request, headers);
    const requested = request.model.replace(/\[1m\]$/i, '');
    const family = requested.match(/^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)/)?.[1] as
      | 'opus'
      | 'sonnet'
      | 'haiku'
      | 'fable'
      | undefined;
    let target: string;
    if (role !== 'main') target = this.config.routing[role] ?? this.defaultModel;
    else if (family) target = this.config.routing[family] ?? this.defaultModel;
    else if (requested === 'default' || requested === 'best') target = this.defaultModel;
    else target = requested;
    const resolved = this.resolve(target);
    const effort =
      this.config.reasoning[role] ??
      (role === 'main' ? request.output_config?.effort : undefined) ??
      resolved.model.defaultEffort;
    if (effort && !resolved.model.efforts.includes(effort))
      throw new BridgeError(
        `Reasoning effort ${/^[a-z]{1,10}$/.test(effort) ? effort : 'requested'} is unsupported by ${resolved.model.id}. Supported: ${resolved.model.efforts.join(', ')}.`,
      );
    return { role, requested: request.model, ...resolved, effort };
  }
  validate() {
    this.resolve(this.defaultModel);
    for (const id of Object.values(this.config.routing)) if (id) this.resolve(id);
    for (const role of ['main', 'subagent', 'classifier', 'compact', 'background'] as const)
      this.route({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'check' }],
        stream: false,
        metadata: { request_type: role },
      });
  }
}
