import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMMessage, LLMResponse, LLMStreamChunk, LLMUsage, ToolArgumentValue } from './types';

const conversationQueues = new WeakMap<object, Promise<void>>();
const activeConversations = new AsyncLocalStorage<ReadonlySet<object>>();

/** Hold one agent's complete history/read/tool/write transaction, not just its HTTP call. */
export async function withAgentConversation<T>(agent: object, run: () => Promise<T>): Promise<T> {
  const active = activeConversations.getStore();
  if (active?.has(agent)) {
    throw new Error(
      'Recursive conversation on the same agent is not supported; use a separate agent for delegation'
    );
  }
  const previous = conversationQueues.get(agent);
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  conversationQueues.set(agent, pending);
  await previous;
  try {
    return await activeConversations.run(new Set([...(active ?? []), agent]), run);
  } finally {
    release();
    if (conversationQueues.get(agent) === pending) conversationQueues.delete(agent);
  }
}

function isToolArgument(value: unknown): value is ToolArgumentValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isToolArgument);
  return typeof value === 'object' && Object.values(value).every(isToolArgument);
}

export function parseToolArguments(input: unknown): Record<string, ToolArgumentValue> {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isToolArgument(value)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return value as Record<string, ToolArgumentValue>;
}

function optionalCost(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const candidate of [record.cost, record.total_cost, record.totalCost]) {
    if (typeof candidate !== 'number' && typeof candidate !== 'string') continue;
    if (typeof candidate === 'string' && candidate.trim() === '') continue;
    const cost = Number(candidate);
    if (Number.isFinite(cost) && cost >= 0) return cost;
  }
  return undefined;
}

export function resolveUsageCost(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  return optionalCost((source as Record<string, unknown>).usage) ?? optionalCost(source);
}

/** Missing billing on even one call keeps a multi-call total unpriced; zero is real usage. */
export function sumUsage(usages: readonly (LLMUsage | undefined)[]): LLMUsage | undefined {
  const reported = usages.filter((usage): usage is LLMUsage => usage !== undefined);
  if (reported.length === 0) return undefined;
  const fullyPriced =
    reported.length === usages.length && reported.every((u) => u.cost !== undefined);
  return {
    promptTokens: reported.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: reported.reduce((sum, usage) => sum + usage.completionTokens, 0),
    totalTokens: reported.reduce((sum, usage) => sum + usage.totalTokens, 0),
    ...(fullyPriced && { cost: reported.reduce((sum, usage) => sum + (usage.cost ?? 0), 0) }),
  };
}

export function requiresNativeHistory(
  messages: readonly Pick<LLMMessage, 'providerData'>[]
): boolean {
  return messages.some(({ providerData }) => {
    if (providerData?.protocol === 'openai-responses') {
      return providerData.output.some((item) => item.type !== 'message');
    }
    if (providerData?.protocol === 'claude-messages') {
      return providerData.content.some((block) => block.type !== 'text');
    }
    return !!(
      providerData?.message.reasoning_details?.length || providerData?.message.tool_calls?.length
    );
  });
}

export async function collectStreamResponse(
  stream: AsyncIterable<LLMStreamChunk>,
  model: string,
  onContent?: (content: string) => void
): Promise<LLMResponse> {
  let content = '';
  let finalChunk: LLMStreamChunk | undefined;
  for await (const chunk of stream) {
    content += chunk.content;
    if (chunk.content) onContent?.(chunk.content);
    if (chunk.done) finalChunk = chunk;
  }
  if (!finalChunk) throw new Error('Stream ended without a final response');
  return {
    content,
    model: finalChunk.model || model,
    toolCalls: finalChunk.toolCalls,
    providerData: finalChunk.providerData,
    usage: finalChunk.usage,
  };
}

export function toAssistantMessage(response: LLMResponse): LLMMessage & { content: string } {
  return {
    role: 'assistant',
    content: response.content,
    tool_calls: response.toolCalls,
    providerData: response.providerData,
  };
}
