import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/graph';
import { Task } from '../src/task';
import { Vision } from '../src/vision';
import { initializeDatabase } from '../src/database';
import { resetEncryptionService } from '../src/database/encryption';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from '../src/llm/providers/openai';
import { ClaudeProvider } from '../src/llm/providers/claude';
import { LLM, clearLLMInstances, resetRateLimiter } from '../src/llm';
import {
  getModelsByProvider,
  getProviderForModel,
  getSupportedModelsList,
} from '../src/llm/models';
import { DEFAULT_AGENT_CONFIG } from '../src/agent/defaults';
import { DEFAULT_LLM_CONFIG } from '../src/llm/defaults';
import {
  collectStreamResponse,
  parseToolArguments,
  sumUsage,
  toAssistantMessage,
} from '../src/llm/utils';
import type { LLMMessage, LLMProviderData, Tool } from '../src/llm/types';
import { ContextManager } from '../src/context/manager';
import { ContextCompressor } from '../src/context/compressor';
import { Agent } from '../src/agent';
import { Logger, initializeLoggerSync } from '../src/logger';

const quiet = new Logger({ level: 'silent', enableConsole: false, enableFile: false });
initializeLoggerSync({ level: 'silent', enableConsole: false, enableFile: false });
const credentials = () => randomBytes(24).toString('hex');

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

const tool: Tool = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Look up a value',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
  usesConfiguredOpenAIKey: boolean;
}
interface WireResponse {
  body: object | string;
  status?: number;
  sse?: boolean;
}

async function withTransport(
  replies:
    | WireResponse[]
    | ((request: CapturedRequest, index: number) => WireResponse | Promise<WireResponse>),
  run: (requests: CapturedRequest[], destinations: URL[]) => Promise<void>
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const destinations: URL[] = [];
  const originalFetch = globalThis.fetch;
  let handlerFailure: unknown;
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of request)
        parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const captured = {
        path: request.url ?? '',
        body: object(body),
        usesConfiguredOpenAIKey:
          !!process.env.OPENAI_API_KEY &&
          request.headers.authorization === `Bearer ${process.env.OPENAI_API_KEY}`,
      };
      requests.push(captured);
      const reply =
        typeof replies === 'function'
          ? await replies(captured, requests.length - 1)
          : replies[requests.length - 1];
      assert.ok(reply, 'Unexpected HTTP request');
      response.writeHead(reply.status ?? 200, {
        'content-type': reply.sse ? 'text/event-stream' : 'application/json',
      });
      response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    } catch (error) {
      handlerFailure = error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'Local contract rejected request', type: 'invalid_request_error' },
        })
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    destinations.push(target);
    assert.ok(
      [
        'api.openai.com',
        'api.anthropic.com',
        'openrouter.ai',
        'gateway.example',
        'localhost',
        '127.0.0.1',
      ].includes(target.hostname),
      'Unexpected network destination'
    );
    const local = `http://127.0.0.1:${address.port}${target.pathname}${target.search}`;
    return originalFetch(local, init);
  };
  try {
    await run(requests, destinations);
    if (handlerFailure) throw handlerFailure;
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    clearLLMInstances();
    resetRateLimiter().destroy();
  }
}

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function responses(
  output: object[],
  model = 'gpt-6-astra',
  usage: object | null = { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
): object {
  return {
    id: randomUUID(),
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    output,
    usage,
    error: null,
    incomplete_details: null,
  };
}
function outputText(text: string): object {
  return {
    id: randomUUID(),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
}
function functionCall(id: string, name: string, args: object): object {
  return {
    type: 'function_call',
    id: randomUUID(),
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}
function chat(message: object, model = 'openai/gpt-5.4-mini', usage?: object): object {
  return {
    id: randomUUID(),
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', refusal: null, ...message },
        finish_reason: 'stop',
      },
    ],
    ...(usage !== undefined && { usage }),
  };
}
function claude(
  content: object[],
  model = 'claude-fable-5-1',
  usage: object | null = { input_tokens: 7, output_tokens: 3 }
): object {
  return {
    id: randomUUID(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: content.some((block) => object(block).type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
    usage,
  };
}
function events(items: object[], done = false): string {
  return (
    items
      .map(
        (item) =>
          `${'type' in item ? `event: ${String(item.type)}\n` : ''}data: ${JSON.stringify(item)}\n\n`
      )
      .join('') + (done ? 'data: [DONE]\n\n' : '')
  );
}
function assertNoUnsupportedParams(body: Record<string, unknown>): void {
  for (const key of ['temperature', 'top_p', 'top_k', 'logprobs', 'top_logprobs', 'fallbacks'])
    assert.equal(key in body, false, key);
}

const directModels = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
];
const claudeModels = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];
const freeModels = [
  'openrouter/free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

test('discovery is synchronous, isolated from credentials, exact, and keeps defaults', async () => {
  await withEnv(
    {
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
    },
    async () => {
      const models = getModelsByProvider('openai');
      assert.ok(Array.isArray(models));
      assert.ok(directModels.every((model) => models.includes(model)));
      assert.ok(freeModels.every((model) => models.includes(model)));
      assert.deepEqual(getModelsByProvider('claude'), claudeModels);
      assert.equal(getProviderForModel('openai/gpt-5.4-mini'), 'openai');
      for (const model of freeModels) assert.equal(getProviderForModel(model), 'openai');
      for (const unknown of [
        'my-gpt-fake',
        'claude-imaginary',
        'google/unknown:free',
        'not-a-model',
        'o4-mini-high',
        'gpt-4.5',
      ]) {
        assert.equal(getProviderForModel(unknown), null);
      }
      models.length = 0;
      assert.ok(getModelsByProvider('openai').length > 0);
      const llm = new LLM(quiet);
      assert.deepEqual(llm.getAvailableProviders(), []);
      assert.deepEqual(llm.getSupportedModels(), getSupportedModelsList());
      await assert.rejects(
        llm.generateResponse({ model: 'unknown', messages: [] }),
        /Unsupported model/
      );
      assert.equal(DEFAULT_AGENT_CONFIG.model, 'gpt-4o-mini');
      assert.equal(DEFAULT_LLM_CONFIG.defaultEmbeddingModel, 'text-embedding-ada-002');
      assert.equal(getProviderForModel(DEFAULT_LLM_CONFIG.defaultEmbeddingModel), 'openai');
      assert.equal(getProviderForModel('llama3.3:70b'), 'ollama');
      assert.ok(getModelsByProvider('ollama').includes('llama3'));
      assert.equal(getProviderForModel('llama3'), 'ollama');
      assert.equal(getProviderForModel('llama3:8b'), 'ollama');
    }
  );
});

test('each current direct model uses real Responses transport and documented output limits', async () => {
  await withTransport(
    (request) => ({ body: responses([outputText('Ready')], String(request.body.model)) }),
    async (requests, destinations) => {
      const provider = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      for (const model of directModels) {
        const result = await provider.generateResponse({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [tool],
          temperature: 0,
          maxTokens: 6000,
        });
        assert.equal(result.content, 'Ready');
        assert.equal(result.usage?.totalTokens, 20);
        assert.equal(result.usage?.cost, undefined);
        const request = requests[requests.length - 1];
        assert.equal(request.path, '/v1/responses');
        assert.equal(request.body.max_output_tokens, 6000);
        assert.equal(request.body.store, false);
        assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
        assertNoUnsupportedParams(request.body);
        assert.equal(object(array(request.body.tools)[0]).name, 'lookup');
      }
      assert.ok(destinations.every((url) => url.hostname === 'api.openai.com'));
      for (const maxTokens of [0, -1, 128001, 1.5]) {
        await assert.rejects(
          provider.generateResponse({ model: 'gpt-6-astra', messages: [], maxTokens }),
          /maxTokens/
        );
      }
      assert.equal(requests.length, directModels.length);
    }
  );
});

test('Responses continuation replays complete opaque output, call IDs, nested args, and zero cost', async () => {
  const id = randomUUID();
  const output = [
    {
      type: 'reasoning',
      id: randomUUID(),
      summary: [],
      encrypted_content: credentials(),
      provider_extension: { future: ['kept'] },
    },
    outputText('Checking'),
    functionCall(id, 'lookup', { query: 'one', filter: { tags: ['x', 'y'], enabled: true } }),
  ];
  await withTransport(
    [
      {
        body: responses(output, 'gpt-6-astra', {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
          cost: 0,
        }),
      },
      { body: responses([outputText('Done')]) },
    ],
    async (requests) => {
      const provider = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const messages: LLMMessage[] = [{ role: 'user', content: 'Find one' }];
      const first = await provider.generateResponse({
        model: 'gpt-6-astra',
        messages,
        tools: [tool],
      });
      assert.equal(first.usage?.cost, 0);
      assert.deepEqual(first.toolCalls?.[0].function.arguments.filter, {
        tags: ['x', 'y'],
        enabled: true,
      });
      messages.push(JSON.parse(JSON.stringify(toAssistantMessage(first))) as LLMMessage);
      messages.push({ role: 'tool', tool_call_id: id, content: '{"found":true}' });
      assert.equal(
        (await provider.generateResponse({ model: 'gpt-6-astra', messages, tools: [tool] }))
          .content,
        'Done'
      );
      assert.deepEqual(array(requests[1].body.input).slice(1, 4), output);
      assert.deepEqual(array(requests[1].body.input)[4], {
        type: 'function_call_output',
        call_id: id,
        output: '{"found":true}',
      });
    }
  );
});

test('Responses stream supports interleaved function fragments and keeps final native output', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = functionCall(firstId, 'lookup', { query: 'first' });
  const second = functionCall(secondId, 'lookup', { query: 'second' });
  const reasoning = {
    type: 'reasoning',
    id: randomUUID(),
    summary: [],
    encrypted_content: credentials(),
  };
  const output = [reasoning, first, second, outputText('Working')];
  const final = responses(output);
  let sequence = 0;
  const emit = (event: object) => ({ ...event, sequence_number: sequence++ });
  const sse = events([
    emit({
      type: 'response.created',
      response: { ...final, status: 'in_progress', output: [], usage: null },
    }),
    emit({ type: 'response.output_item.added', output_index: 0, item: reasoning }),
    emit({
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...first, arguments: '' },
    }),
    emit({
      type: 'response.output_item.added',
      output_index: 2,
      item: { ...second, arguments: '' },
    }),
    emit({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: object(first).id,
      delta: '{"query":',
    }),
    emit({
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      item_id: object(second).id,
      delta: '{"query":"sec',
    }),
    emit({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: object(first).id,
      delta: '"first"}',
    }),
    emit({
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      item_id: object(second).id,
      delta: 'ond"}',
    }),
    emit({ type: 'response.output_item.done', output_index: 1, item: first }),
    emit({ type: 'response.output_item.done', output_index: 2, item: second }),
    emit({
      type: 'response.output_item.added',
      output_index: 3,
      item: { ...output[3], content: [] },
    }),
    emit({
      type: 'response.content_part.added',
      output_index: 3,
      content_index: 0,
      item_id: object(output[3]).id,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
    emit({
      type: 'response.output_text.delta',
      output_index: 3,
      content_index: 0,
      item_id: object(output[3]).id,
      delta: 'Working',
      logprobs: [],
    }),
    emit({ type: 'response.output_item.done', output_index: 3, item: output[3] }),
    emit({ type: 'response.completed', response: final }),
  ]);
  await withTransport(
    [{ body: sse, sse: true }, { body: responses([outputText('Done')]) }],
    async (requests) => {
      const provider = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const chunks: string[] = [];
      const response = await collectStreamResponse(
        provider.generateStreamResponse({
          model: 'gpt-6-astra',
          messages: [{ role: 'user', content: 'Find two' }],
          tools: [tool],
        }),
        'gpt-6-astra',
        (text) => chunks.push(text)
      );
      assert.equal(chunks.join(''), 'Working');
      assert.equal(response.toolCalls?.length, 2);
      assert.equal(response.toolCalls?.[0].id, firstId);
      assert.equal(response.toolCalls?.[1].function.arguments.query, 'second');
      assert.equal(response.usage?.totalTokens, 20);
      assert.equal(response.providerData?.protocol, 'openai-responses');
      // The SDK final snapshot also contains parsed:null helper fields. The next
      // real request must strip only SDK-only fields, not native response data.
      await provider.generateResponse({
        model: 'gpt-6-astra',
        messages: [
          { role: 'user', content: 'Find two' },
          toAssistantMessage(response),
          { role: 'tool', tool_call_id: firstId, content: 'one' },
          { role: 'tool', tool_call_id: secondId, content: 'two' },
        ],
        tools: [tool],
      });
      assert.deepEqual(array(requests[1].body.input).slice(1, 5), output);
    }
  );
});

test('retained CLI llama3 models route to Ollama without changing their IDs', async () => {
  await withEnv(
    {
      OLLAMA_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
    },
    async () => {
      await withTransport(
        (request) => ({
          body: {
            model: request.body.model,
            message: { role: 'assistant', content: 'Local answer' },
            done: true,
            prompt_eval_count: 1,
            eval_count: 1,
          },
        }),
        async (requests, destinations) => {
          const llm = new LLM(quiet);
          for (const model of ['llama3', 'llama3:8b']) {
            const result = await llm.generateResponse({
              model,
              messages: [{ role: 'user', content: 'Hello' }],
            });
            assert.equal(result.model, model);
            assert.equal(result.content, 'Local answer');
          }
          assert.deepEqual(
            requests.map((request) => request.body.model),
            ['llama3', 'llama3:8b']
          );
          assert.ok(requests.every((request) => request.path === '/api/chat'));
          assert.ok(destinations.every((destination) => destination.hostname === 'localhost'));
        }
      );
    }
  );
});

test('production gateway retains Chat Completions and configured endpoint/key', async () => {
  const apiKey = credentials();
  await withEnv(
    { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' },
    async () => {
      await withTransport(
        [
          {
            body: chat({ content: 'Same route' }, 'openai/gpt-5.4-mini', {
              prompt_tokens: 2,
              completion_tokens: 3,
              total_tokens: 5,
              cost: 0.01,
            }),
          },
        ],
        async (requests, destinations) => {
          const result = await new LLM(quiet).generateResponse({
            model: 'openai/gpt-5.4-mini',
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.7,
            maxTokens: 1200,
            tools: [tool],
          });
          assert.equal(requests[0].path, '/api/v1/chat/completions');
          assert.equal(requests[0].body.model, 'openai/gpt-5.4-mini');
          assert.equal(requests[0].body.max_completion_tokens, 1200);
          assertNoUnsupportedParams(requests[0].body);
          assert.equal(destinations[0].hostname, 'openrouter.ai');
          assert.equal(requests[0].usesConfiguredOpenAIKey, true);
          assert.equal(result.usage?.cost, 0.01);
        }
      );
    }
  );
});

test('free routes require the real configured gateway, never direct or paid fallback', async () => {
  const direct = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
  const otherGateway = new OpenAIProvider({
    apiKey: credentials(),
    baseUrl: 'https://gateway.example/v1',
    logger: quiet,
  });
  for (const model of freeModels) {
    await assert.rejects(direct.generateResponse({ model, messages: [] }), /gateway/);
    await assert.rejects(otherGateway.generateResponse({ model, messages: [] }), /openrouter.ai/);
  }
  await assert.rejects(
    direct.generateResponse({ model: 'openai/gpt-5.4-mini', messages: [] }),
    /gateway/
  );
  await withTransport(
    (request) => ({
      body: chat({ content: 'Free route' }, String(request.body.model), {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        cost: 0,
      }),
    }),
    async (requests) => {
      const gateway = new OpenAIProvider({
        apiKey: credentials(),
        baseUrl: 'https://openrouter.ai/api/v1',
        logger: quiet,
      });
      for (const model of freeModels) {
        const result = await gateway.generateResponse({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [tool],
        });
        assert.equal(result.usage?.cost, 0);
        assert.equal(requests[requests.length - 1].path, '/api/v1/chat/completions');
        assert.equal(requests[requests.length - 1].body.model, model);
        assert.equal('models' in requests[requests.length - 1].body, false);
      }
    }
  );
});

test('gateway streaming assembles interleaved tools including late IDs and opaque reasoning', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const opaqueBlocks = [
    { index: 1, type: 'reasoning.encrypted', data: credentials(), format: 'opaque' },
    { type: 'reasoning.encrypted', data: credentials(), format: 'opaque' },
    { index: 0, type: 'reasoning.text', text: '', signature: credentials(), format: 'opaque' },
  ];
  const deltas = [
    {
      tool_calls: [
        { index: 1, type: 'function', function: { name: 'look', arguments: '{"query":' } },
      ],
      reasoning_details: [opaqueBlocks[0]],
    },
    {
      tool_calls: [
        {
          index: 0,
          id: firstId,
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"first"}' },
        },
      ],
    },
    {
      tool_calls: [{ index: 1, id: secondId, function: { name: 'up', arguments: '"second"}' } }],
      reasoning_details: opaqueBlocks.slice(1),
    },
    { content: 'Checking' },
  ];
  const model = freeModels[1];
  const sse = events(
    [
      ...deltas.map((delta) => ({
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })),
      {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
      {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, cost: 0 },
      },
    ],
    true
  );
  await withTransport(
    [{ body: sse, sse: true }, { body: chat({ content: 'Done' }, model) }],
    async (requests) => {
      const gateway = new OpenAIProvider({
        apiKey: credentials(),
        baseUrl: 'https://openrouter.ai/api/v1',
        logger: quiet,
      });
      const response = await collectStreamResponse(
        gateway.generateStreamResponse({
          model,
          messages: [{ role: 'user', content: 'Find two' }],
          tools: [tool],
        }),
        model
      );
      assert.equal(response.content, 'Checking');
      assert.deepEqual(
        response.toolCalls?.map((call) => [
          call.id,
          call.function.name,
          call.function.arguments.query,
        ]),
        [
          [firstId, 'lookup', 'first'],
          [secondId, 'lookup', 'second'],
        ]
      );
      assert.equal(response.usage?.cost, 0);
      assert.equal(response.providerData?.protocol, 'openai-chat-completions');
      await gateway.generateResponse({
        model,
        messages: [
          { role: 'user', content: 'Find two' },
          toAssistantMessage(response),
          { role: 'tool', tool_call_id: firstId, content: 'one' },
          { role: 'tool', tool_call_id: secondId, content: 'two' },
        ],
        tools: [tool],
      });
      const replay = object(array(requests[1].body.messages)[1]);
      assert.deepEqual(replay.reasoning_details, opaqueBlocks);
      assert.equal(object(array(replay.tool_calls)[1]).id, secondId);
    }
  );
});

test('current Claude models use stable Messages and model-specific parameters', async () => {
  await withTransport(
    (request) => ({
      body: claude([{ type: 'text', text: 'Ready', citations: null }], String(request.body.model)),
    }),
    async (requests) => {
      const provider = new ClaudeProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      for (const model of claudeModels) {
        const result = await provider.generateResponse({
          model,
          messages: [
            { role: 'system', content: 'Be concise' },
            { role: 'user', content: 'Hello' },
          ],
          tools: [tool],
          temperature: 0,
          maxTokens: 6000,
        });
        assert.equal(result.content, 'Ready');
        const request = requests[requests.length - 1];
        assert.equal(request.path, '/v1/messages');
        assert.equal(request.body.system, 'Be concise');
        assert.deepEqual(request.body.tool_choice, { type: 'auto' });
        assert.equal(request.body.max_tokens, 6000);
        assert.equal('thinking' in request.body, false);
        if (model.startsWith('claude-haiku')) assert.equal(request.body.temperature, 0);
        else assertNoUnsupportedParams(request.body);
      }
    }
  );
});

test('Claude passes every thinking/signature/redacted/tool block unchanged with grouped results', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const blocks = [
    { type: 'thinking', thinking: '', signature: credentials(), extra: { future: 'retain' } },
    { type: 'redacted_thinking', data: credentials() },
    { type: 'text', text: 'Checking', citations: null },
    {
      type: 'tool_use',
      id: firstId,
      name: 'lookup',
      input: { query: 'first', nested: { a: [1, 2] } },
    },
    { type: 'tool_use', id: secondId, name: 'lookup', input: { query: 'second' } },
  ];
  await withTransport(
    [
      {
        body: claude(blocks, 'claude-fable-5-1', {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
          cost: 0,
        }),
      },
      { body: claude([{ type: 'text', text: 'Done', citations: null }]) },
    ],
    async (requests) => {
      const provider = new ClaudeProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const first = await provider.generateResponse({
        model: 'claude-fable-5-1',
        messages: [{ role: 'user', content: 'Find two' }],
        tools: [tool],
      });
      assert.equal(first.content, 'Checking');
      assert.deepEqual(first.usage, {
        promptTokens: 14,
        completionTokens: 3,
        totalTokens: 17,
        cost: 0,
      });
      await provider.generateResponse({
        model: 'claude-fable-5-1',
        tools: [tool],
        messages: [
          { role: 'user', content: 'Find two' },
          toAssistantMessage(first),
          { role: 'tool', tool_call_id: firstId, content: 'one' },
          { role: 'tool', tool_call_id: secondId, content: 'two' },
        ],
      });
      const messages = array(requests[1].body.messages);
      assert.equal(messages.length, 3);
      assert.deepEqual(object(messages[1]).content, blocks);
      assert.deepEqual(
        array(object(messages[2]).content).map((block) => object(block).tool_use_id),
        [firstId, secondId]
      );
    }
  );
});

function claudeStream(firstId: string, secondId: string, signature: string): string {
  return events([
    {
      type: 'message_start',
      message: {
        ...claude([], 'claude-fable-5-1', {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: 2,
        }),
        stop_reason: null,
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: credentials() },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: firstId, name: 'lookup', input: {} },
    },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'tool_use', id: secondId, name: 'lookup', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{"query":"sec' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '"first"}' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: 'ond"}' },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'content_block_start',
      index: 4,
      content_block: { type: 'text', text: '', citations: null },
    },
    { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'Checking' } },
    { type: 'content_block_stop', index: 4 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: 'message_stop' },
  ]);
}

test('Claude stream assembles interleaved JSON, signatures, usage and multi-turn continuation', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const signature = credentials();
  await withTransport(
    [
      { body: claudeStream(firstId, secondId, signature), sse: true },
      { body: claude([{ type: 'text', text: 'Done', citations: null }]) },
    ],
    async (requests) => {
      const provider = new ClaudeProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const response = await collectStreamResponse(
        provider.generateStreamResponse({
          model: 'claude-fable-5-1',
          messages: [{ role: 'user', content: 'Find two' }],
          tools: [tool],
        }),
        'claude-fable-5-1'
      );
      assert.equal(response.content, 'Checking');
      assert.deepEqual(
        response.toolCalls?.map((call) => [call.id, call.function.arguments.query]),
        [
          [firstId, 'first'],
          [secondId, 'second'],
        ]
      );
      assert.equal(response.usage?.promptTokens, 7);
      assert.equal(response.usage?.completionTokens, 9);
      assert.equal(response.usage?.cost, undefined);
      assert.equal(response.providerData?.protocol, 'claude-messages');
      if (response.providerData?.protocol !== 'claude-messages')
        throw new Error('Missing native state');
      assert.equal(object(response.providerData.content[0]).signature, signature);
      await provider.generateResponse({
        model: 'claude-fable-5-1',
        tools: [tool],
        messages: [
          { role: 'user', content: 'Find two' },
          toAssistantMessage(response),
          { role: 'tool', tool_call_id: firstId, content: 'one' },
          { role: 'tool', tool_call_id: secondId, content: 'two' },
        ],
      });
      assert.deepEqual(
        object(array(requests[1].body.messages)[1]).content,
        response.providerData.content
      );
    }
  );
});

test('missing usage is not fabricated, cost parsing distinguishes zero/blank, and aggregation fails closed', async () => {
  await withTransport(
    [
      { body: chat({ content: 'Unpriced' }) },
      {
        body: chat({ content: 'Zero' }, 'openai/gpt-5.4-mini', {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cost: '0',
        }),
      },
      {
        body: chat({ content: 'Blank' }, 'openai/gpt-5.4-mini', {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          cost: '',
        }),
      },
      { body: responses([outputText('Missing')], 'gpt-6-astra', null) },
    ],
    async () => {
      const gateway = new OpenAIProvider({
        apiKey: credentials(),
        baseUrl: 'https://openrouter.ai/api/v1',
        logger: quiet,
      });
      const request = {
        model: 'openai/gpt-5.4-mini',
        messages: [{ role: 'user' as const, content: 'Hello' }],
      };
      const missing = await gateway.generateResponse(request);
      const zero = await gateway.generateResponse(request);
      const blank = await gateway.generateResponse(request);
      assert.equal(missing.usage, undefined);
      assert.equal(zero.usage?.cost, 0);
      assert.equal(blank.usage?.cost, undefined);
      assert.equal(sumUsage([zero.usage, zero.usage])?.cost, 0);
      assert.equal(sumUsage([missing.usage, zero.usage])?.cost, undefined);
      assert.equal(sumUsage([zero.usage, blank.usage])?.cost, undefined);
      assert.equal(sumUsage([undefined, undefined]), undefined);
      const direct = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      assert.equal(
        (await direct.generateResponse({ ...request, model: 'gpt-6-astra' })).usage,
        undefined
      );
    }
  );
  assert.deepEqual(parseToolArguments('{"a":[1,{"b":false}]}'), { a: [1, { b: false }] });
  assert.throws(() => parseToolArguments('[]'), /JSON object/);
  assert.throws(() => parseToolArguments('{bad'));
});

test('native context import/export preserves all fields and guards compression only when needed', async () => {
  const native: LLMProviderData = {
    protocol: 'claude-messages',
    model: 'claude-fable-5-1',
    content: [
      { type: 'thinking', thinking: '', signature: credentials() },
      { type: 'redacted_thinking', data: credentials() },
    ],
  };
  const messages = [
    {
      role: 'user',
      content: 'Image',
      inputContent: [
        { type: 'text', text: 'Image' },
        { type: 'image_url', image_url: { url: 'https://images.example/plant.png' } },
      ],
    },
    { role: 'assistant', content: '', providerData: native },
    { role: 'tool', content: 'Result', tool_call_id: randomUUID() },
  ];
  const manager = new ContextManager({ autoCompress: false, maxContextLength: 1 });
  manager.importContext(JSON.stringify({ messages }));
  const exported = object(JSON.parse(manager.exportContext()));
  const replay = array(exported.messages).map((message) => {
    const rest = { ...object(message) };
    delete rest.timestamp;
    delete rest.metadata;
    return rest;
  });
  assert.deepEqual(replay, messages);
  assert.equal((await manager.compressContext()).success, false);
  assert.equal(manager.getMessages().length, 3);
  const compressor = new ContextCompressor({ maxContextLength: 10000 });
  assert.equal(
    (await compressor.compressConversation([{ role: 'user', content: 'Simple' }])).success,
    true
  );
  await manager.dispose();
});

test('mismatched native model/protocol and malformed/truncated tools fail instead of dropping state', async () => {
  const provider = new ClaudeProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
  await assert.rejects(
    provider.generateResponse({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'assistant',
          content: '',
          providerData: {
            protocol: 'claude-messages',
            model: 'claude-fable-5-1',
            content: [{ type: 'thinking', thinking: '', signature: credentials() }],
          },
        },
      ],
    }),
    /different model/
  );
  await assert.rejects(
    provider.generateResponse({ model: 'claude-not-real', messages: [] }),
    /Unsupported/
  );
  await withTransport(
    [{ body: responses([{ ...functionCall(randomUUID(), 'lookup', {}), arguments: '{broken' }]) }],
    async () => {
      const direct = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      await assert.rejects(
        direct.generateResponse({
          model: 'gpt-6-astra',
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [tool],
        }),
        /request failed/
      );
    }
  );
});

test('Agent.ask performs streamed native tools and retains opaque context for the next user turn', async () => {
  const toolId = randomUUID();
  const signature = credentials();
  await withEnv(
    {
      OPENAI_API_KEY: credentials(),
      OPENAI_BASE_URL: undefined,
      ANTHROPIC_API_KEY: credentials(),
      ANTHROPIC_BASE_URL: undefined,
      LOG_LEVEL: 'silent',
    },
    async () => {
      await withTransport(
        [
          {
            body: events([
              {
                type: 'message_start',
                message: { ...claude([], 'claude-fable-5-1'), stop_reason: null },
              },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: toolId, name: 'plugin_lookup', input: {} },
              },
              { type: 'content_block_stop', index: 1 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 5 },
              },
              { type: 'message_stop' },
            ]),
            sse: true,
          },
          {
            body: events([
              {
                type: 'message_start',
                message: { ...claude([], 'claude-fable-5-1'), stop_reason: null },
              },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '', citations: null },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Found result' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 3 },
              },
              { type: 'message_stop' },
            ]),
            sse: true,
          },
          { body: claude([{ type: 'text', text: 'Next turn', citations: null }]) },
        ],
        async (requests) => {
          const agent = new Agent({
            ...DEFAULT_AGENT_CONFIG,
            id: randomUUID(),
            name: 'Native test',
            model: 'claude-fable-5-1',
            memory: false,
            knowledge: false,
            vision: false,
            useTools: true,
            autoContextCompression: false,
            debug: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          let executions = 0;
          await agent.registerPlugin({
            name: 'contract',
            version: '1.0.0',
            description: 'Local contract tool',
            tools: [
              {
                name: 'lookup',
                description: 'Return a local value',
                parameters: {},
                handler: async () => {
                  executions++;
                  return { success: true, data: 'Found' };
                },
              },
            ],
          });
          const text: string[] = [];
          assert.equal(
            await agent.ask('Run a tool', { stream: true, onChunk: (chunk) => text.push(chunk) }),
            'Found result'
          );
          assert.equal(text.join(''), 'Found result');
          assert.equal(executions, 1);
          assert.ok(
            array(requests[0].body.tools).some((entry) => object(entry).name === 'plugin_lookup')
          );
          const replay = object(array(requests[1].body.messages)[1]);
          assert.equal(object(array(replay.content)[0]).signature, signature);
          assert.equal(agent.getContext().filter((message) => message.role === 'tool').length, 1);
          assert.equal(await agent.ask('Continue'), 'Next turn');
          assert.deepEqual(
            array(requests[2].body.messages).slice(0, 3),
            array(requests[1].body.messages)
          );
          const saved = agent.exportContext();
          const nativeBefore = agent.getContext().map((message) => message.providerData);
          await agent.clearContext();
          assert.equal(agent.getContext().length, 0);
          agent.importContext(saved);
          assert.deepEqual(
            agent.getContext().map((message) => message.providerData),
            nativeBefore
          );
          await agent.destroy();
        }
      );
    }
  );
});

function responseStream(response: object): string {
  const output = array(object(response).output);
  const stream: object[] = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
  ];
  for (const [index, value] of output.entries()) {
    const item = object(value);
    stream.push({
      type: 'response.output_item.added',
      output_index: index,
      item: {
        ...item,
        ...(item.type === 'function_call'
          ? { arguments: '' }
          : item.type === 'message'
            ? { content: [] }
            : {}),
      },
    });
    if (item.type === 'function_call') {
      stream.push({
        type: 'response.function_call_arguments.delta',
        output_index: index,
        item_id: item.id,
        delta: item.arguments,
      });
    } else if (item.type === 'message') {
      const text = object(array(item.content)[0]).text;
      stream.push({
        type: 'response.content_part.added',
        output_index: index,
        content_index: 0,
        item_id: item.id,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      stream.push({
        type: 'response.output_text.delta',
        output_index: index,
        content_index: 0,
        item_id: item.id,
        delta: text,
        logprobs: [],
      });
    }
    stream.push({ type: 'response.output_item.done', output_index: index, item });
  }
  stream.push({ type: 'response.completed', response });
  return events(stream.map((event, sequence_number) => ({ ...event, sequence_number })));
}

test('real Task/Graph loops retain native transcripts and current-node zero versus unknown costs in both modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astreus-native-'));
  await withEnv(
    {
      OPENAI_API_KEY: credentials(),
      OPENAI_BASE_URL: undefined,
      ENCRYPTION_ENABLED: 'true',
      ENCRYPTION_MASTER_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'silent',
    },
    async () => {
      resetEncryptionService();
      const database = await initializeDatabase(
        { connectionString: `sqlite://${join(directory, 'native.sqlite')}` },
        quiet
      );
      try {
        for (const streaming of [false, true]) {
          const expectedOutputs: object[][] = [];
          const agent = await Agent.create({
            name: `native-${randomUUID()}`,
            model: 'gpt-6-astra',
            memory: false,
            useTools: true,
            maxTokens: 6000,
          });
          let executions = 0;
          await agent.registerPlugin({
            name: 'contract',
            version: '1.0.0',
            description: 'Local contract tool',
            tools: [
              {
                name: 'lookup',
                description: 'Return a local value',
                parameters: {},
                handler: async () => {
                  executions++;
                  return { success: true, data: 'Found' };
                },
              },
            ],
          });
          const graph = new Graph({ name: `native-${randomUUID()}`, maxConcurrency: 2 }, agent);
          const firstNode = graph.addTaskNode({ prompt: 'First', stream: streaming });
          const secondNode = graph.addTaskNode({ prompt: 'Second', stream: streaming });
          const graphId = await graph.save();
          try {
            await withTransport(
              (request, index) => {
                const output =
                  index % 2 === 0
                    ? [
                        {
                          type: 'reasoning',
                          id: randomUUID(),
                          summary: [],
                          encrypted_content: credentials(),
                        },
                        functionCall(randomUUID(), 'plugin_lookup', {}),
                      ]
                    : [outputText(index === 1 ? 'First result' : 'Second result')];
                expectedOutputs.push(output);
                const response = responses(output, 'gpt-6-astra', {
                  input_tokens: 5,
                  output_tokens: 5,
                  total_tokens: 10,
                  ...(index !== 1 && { cost: 0 }),
                });
                return request.body.stream
                  ? { body: responseStream(response), sse: true }
                  : { body: response };
              },
              async (requests) => {
                const result = await graph.run({ stream: streaming, onChunk: () => undefined });
                assert.equal(result.success, true);
                assert.equal(executions, 2);
                assert.equal(requests.length, 4);
                // The first prompt is not pre-saved and duplicated in model input.
                assert.equal(
                  array(requests[0].body.input).filter((item) => object(item).role === 'user')
                    .length,
                  1
                );
                const firstPrompt = object(
                  array(requests[0].body.input).find((item) => object(item).role === 'user')
                ).content;
                const initialNode = firstPrompt === 'First' ? firstNode : secondNode;
                const followingNode = initialNode === firstNode ? secondNode : firstNode;
                const first = object(JSON.parse(String(result.results[initialNode])));
                const second = object(JSON.parse(String(result.results[followingNode])));
                assert.equal(object(first.usage).cost, undefined);
                assert.equal(object(second.usage).cost, 0);
                assert.equal(object(first.usage).totalTokens, 20);
                const firstMessages = array(first.messages);
                assert.equal(firstMessages.length, 4);
                assert.equal(object(firstMessages[2]).role, 'tool');
                assert.equal(
                  object(object(firstMessages[1]).providerData).protocol,
                  'openai-responses'
                );
                assert.deepEqual(array(requests[1].body.input).slice(1, 3), expectedOutputs[0]);
                assert.deepEqual(array(requests[2].body.input).slice(1, 3), expectedOutputs[0]);
                assert.equal(
                  agent.getContext().filter((message) => message.role === 'tool').length,
                  2
                );
                await graph.update();
                const loaded = await Graph.findById(graphId, agent);
                assert.ok(loaded);
                const savedFirst = loaded.getGraph().nodes.find((node) => node.id === initialNode);
                const restored = object(JSON.parse(String(savedFirst?.result)));
                assert.deepEqual(restored.messages, first.messages);
                await loaded.destroy();
              }
            );
          } finally {
            await graph.destroy();
            await agent.destroy();
          }
        }
        const agent = await Agent.create({
          name: `direct-${randomUUID()}`,
          model: 'gpt-6-astra',
          memory: false,
          useTools: true,
        });
        let recursionRejected = false;
        await agent.registerPlugin({
          name: 'contract',
          version: '1.0.0',
          description: 'Local recursive guard contract',
          tools: [
            {
              name: 'lookup',
              description: 'Check recursive rejection',
              parameters: {},
              handler: async () => {
                await assert.rejects(
                  agent.ask('Recursive'),
                  /Recursive conversation on the same agent/
                );
                recursionRejected = true;
                return { success: true, data: 'Found' };
              },
            },
          ],
        });
        const taskModule = new Task(agent);
        await taskModule.initialize();
        const task = await taskModule.createTask({ prompt: 'Task first' });
        const failing = await taskModule.createTask({ prompt: 'Rejected task' });
        assert.ok(task.id && failing.id);
        const output = [functionCall(randomUUID(), 'plugin_lookup', {})];
        try {
          await withTransport(
            [
              { body: responses(output) },
              { body: responses([outputText('Task done')]) },
              { body: responses([outputText('Ask done')]) },
              {
                body: {
                  error: { message: 'Rejected contract request', type: 'invalid_request_error' },
                },
                status: 400,
              },
              { body: responses([outputText('Recovered')]) },
            ],
            async (requests) => {
              const [taskResult, askResult] = await Promise.all([
                taskModule.executeTask(task.id!),
                agent.ask('Ask second'),
              ]);
              assert.equal(taskResult.response, 'Task done');
              assert.equal(askResult, 'Ask done');
              assert.equal(recursionRejected, true);
              assert.deepEqual(array(requests[2].body.input).slice(1, 2), output);
              assert.deepEqual(
                agent.getContext().map((message) => message.role),
                ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant']
              );
              await assert.rejects(taskModule.executeTask(failing.id!), /request failed/);
              assert.equal(await agent.ask('Recover after failed task'), 'Recovered');
            }
          );
        } finally {
          await agent.destroy();
        }

        const parent = await Agent.create({
          name: `parent-${randomUUID()}`,
          model: 'gpt-6-astra',
          memory: false,
          useTools: false,
        });
        const child = new Agent({
          ...DEFAULT_AGENT_CONFIG,
          id: randomUUID(),
          name: 'Delegated child',
          model: 'gpt-6-astra',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        parent.config.subAgents = [child];
        let parentRecursionRejected = false;
        await child.registerPlugin({
          name: 'contract',
          version: '1.0.0',
          description: 'Delegation boundary contract',
          tools: [
            {
              name: 'lookup',
              description: 'Check parent boundary',
              parameters: {},
              handler: async () => {
                await assert.rejects(
                  parent.ask('Recursive parent'),
                  /Recursive conversation on the same agent/
                );
                await assert.rejects(
                  child.ask('Recursive child'),
                  /Recursive conversation on the same agent/
                );
                parentRecursionRejected = true;
                return { success: true, data: 'Delegated value' };
              },
            },
          ],
        });
        const delegatedModule = new Task(parent);
        await delegatedModule.initialize();
        const delegatedTask = await delegatedModule.createTask({
          prompt: 'Delegate this task',
          useSubAgents: true,
          subAgentDelegation: 'sequential',
        });
        assert.ok(delegatedTask.id);
        try {
          await withTransport(
            [
              { body: responses([functionCall(randomUUID(), 'plugin_lookup', {})]) },
              { body: responses([outputText('Delegated result')]) },
              { body: responses([outputText('Parent follows')]) },
            ],
            async (requests) => {
              const [result, following] = await Promise.all([
                delegatedModule.executeTask(delegatedTask.id!),
                parent.ask('Follow the delegated task'),
              ]);
              assert.ok(result.response.includes('Delegated result'));
              assert.equal(parentRecursionRejected, true);
              assert.equal(following, 'Parent follows');
              assert.equal(requests.length, 3);
              assert.deepEqual(
                result.messages?.map((message) => message.role),
                ['user', 'assistant']
              );
              assert.equal(
                parent.getContext().filter((message) => message.role === 'user').length,
                2
              );
            }
          );
        } finally {
          await child.destroy();
          await parent.destroy();
        }
      } finally {
        await database.disconnect();
        resetEncryptionService();
      }
    }
  );
  await rm(directory, { recursive: true, force: true });
});

test('vision uses the selected current transport/model and never silently replaces retired Claude defaults', async () => {
  await withTransport(
    (request) => ({
      body:
        request.path === '/v1/responses'
          ? responses([outputText('An image')], String(request.body.model))
          : claude(
              [
                { type: 'thinking', thinking: '', signature: credentials() },
                { type: 'text', text: 'An image', citations: null },
              ],
              String(request.body.model)
            ),
    }),
    async (requests) => {
      const direct = new OpenAIProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const provider = new ClaudeProvider({ apiKey: credentials(), baseUrl: null, logger: quiet });
      const image = `data:image/png;base64,${randomBytes(12).toString('base64')}`;
      assert.equal(
        (await direct.analyzeImageFromBase64(image, { model: 'gpt-6-astra' })).content,
        'An image'
      );
      assert.equal(requests[0].path, '/v1/responses');
      assertNoUnsupportedParams(requests[0].body);
      assert.equal(
        (await provider.analyzeImageFromBase64(image, { model: 'claude-sonnet-5' })).content,
        'An image'
      );
      assertNoUnsupportedParams(requests[1].body);
      await assert.rejects(provider.analyzeImageFromBase64(image), /retired.*explicitly/);
      assert.equal(requests.length, 2);
      assert.equal(direct.getVisionModels()[0], 'gpt-4o');
      assert.equal(direct.getEmbeddingModels()[0], 'text-embedding-3-large');
    }
  );
});

test('Vision module honors explicit Claude selection and keeps local-only fallback unchanged', async () => {
  await withEnv(
    {
      OPENAI_API_KEY: undefined,
      OPENAI_VISION_API_KEY: undefined,
      ANTHROPIC_API_KEY: credentials(),
      ANTHROPIC_VISION_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_VISION_API_KEY: undefined,
      OLLAMA_BASE_URL: undefined,
      LOG_LEVEL: 'silent',
    },
    async () => {
      const image = `data:image/png;base64,${randomBytes(12).toString('base64')}`;
      await withTransport(
        (request) => ({
          body:
            request.path === '/api/generate'
              ? {
                  model: 'llava',
                  response: 'Local image',
                  done: true,
                  prompt_eval_count: 1,
                  eval_count: 1,
                }
              : claude(
                  [{ type: 'text', text: 'Selected image', citations: null }],
                  String(request.body.model)
                ),
        }),
        async (requests) => {
          await assert.rejects(new Vision().analyzeImageFromBase64(image), /retired.*explicitly/);
          await assert.rejects(
            new Vision(undefined, { model: 'claude-3-5-sonnet-20241022' }).analyzeImageFromBase64(
              image
            ),
            /supported vision model/
          );
          assert.equal(requests.length, 0);
          const agent = new Agent({
            ...DEFAULT_AGENT_CONFIG,
            id: randomUUID(),
            name: 'Vision test',
            model: 'claude-sonnet-5',
            memory: false,
            vision: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          try {
            assert.equal(await new Vision(agent).analyzeImageFromBase64(image), 'Selected image');
            assert.equal(requests[0].body.model, 'claude-sonnet-5');
            assert.equal(
              await new Vision(agent, {
                model: 'claude-haiku-4-5-20251001',
              }).analyzeImageFromBase64(image),
              'Selected image'
            );
            assert.equal(requests[1].body.model, 'claude-haiku-4-5-20251001');
            const explicit = new Agent({
              ...DEFAULT_AGENT_CONFIG,
              id: randomUUID(),
              name: 'Explicit vision test',
              model: 'gpt-4o-mini',
              visionModel: 'claude-opus-5',
              memory: false,
              vision: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            try {
              assert.equal(
                await new Vision(explicit).analyzeImageFromBase64(image),
                'Selected image'
              );
              assert.equal(requests[2].body.model, 'claude-opus-5');
            } finally {
              await explicit.destroy();
            }
          } finally {
            await agent.destroy();
          }
          await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
            assert.equal(await new Vision().analyzeImageFromBase64(image), 'Local image');
            assert.equal(requests[3].body.model, 'llava');
          });
        }
      );
    }
  );
});

test('distinct agent conversations still execute concurrently', async () => {
  await withEnv(
    { OPENAI_API_KEY: credentials(), OPENAI_BASE_URL: undefined, LOG_LEVEL: 'silent' },
    async () => {
      const agents = [0, 1].map(
        (index) =>
          new Agent({
            ...DEFAULT_AGENT_CONFIG,
            id: randomUUID(),
            name: `Concurrent ${index}`,
            model: 'gpt-6-astra',
            memory: false,
            vision: false,
            useTools: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
      );
      let arrived = 0;
      let release: () => void = () => undefined;
      let timer: NodeJS.Timeout | undefined;
      const bothArrived = new Promise<void>((resolve, reject) => {
        release = resolve;
        timer = setTimeout(() => reject(new Error('Distinct agents were serialized')), 3000);
      });
      try {
        await withTransport(
          async () => {
            if (++arrived === 2) release();
            await bothArrived;
            return { body: responses([outputText('Concurrent result')]) };
          },
          async (requests) => {
            assert.deepEqual(
              await Promise.all(agents.map((agent) => agent.ask('Concurrent request'))),
              ['Concurrent result', 'Concurrent result']
            );
            assert.equal(requests.length, 2);
          }
        );
      } finally {
        release();
        clearTimeout(timer);
        await Promise.all(agents.map((agent) => agent.destroy()));
      }
    }
  );
});
