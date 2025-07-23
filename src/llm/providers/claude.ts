import { LLMProvider, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMConfig } from '../types';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockDeltaEvent, TextDelta } from '@anthropic-ai/sdk/resources/messages';
import type { ToolUseBlock, ToolsBetaContentBlock } from '@anthropic-ai/sdk/resources/beta/tools/messages';

export class ClaudeProvider implements LLMProvider {
  name = 'claude';
  private client: Anthropic;

  constructor(config?: LLMConfig) {
    const apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable.');
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config?.baseUrl || process.env.ANTHROPIC_BASE_URL
    });
  }

  getSupportedModels(): string[] {
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3.7-sonnet-20250224',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ];
  }

  async generateResponse(options: LLMRequestOptions): Promise<LLMResponse> {
    const { system, messages } = this.prepareMessages(options);
    
    const message = await this.client.messages.create({
      model: options.model,
      messages: messages as Anthropic.Messages.MessageParam[],
      system,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
      ...(options.tools && options.tools.length > 0 && {
        tools: options.tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters
        }))
      })
    });

    // Extract tool calls from Claude's response
    const toolCalls = (message.content as ToolsBetaContentBlock[])
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: block.input || {}
        }
      }));

    const textContent = (message.content as ToolsBetaContentBlock[])
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    
    return {
      content: textContent,
      model: message.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens
      }
    };
  }

  async* generateStreamResponse(options: LLMRequestOptions): AsyncIterableIterator<LLMStreamChunk> {
    const { system, messages } = this.prepareMessages(options);
    
    const stream = await this.client.messages.create({
      model: options.model,
      messages: messages as Anthropic.Messages.MessageParam[],
      system,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      ...(options.tools && options.tools.length > 0 && {
        tools: options.tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters
        }))
      })
    });

    const toolCalls: any[] = [];

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const deltaEvent = event as ContentBlockDeltaEvent;
          if (deltaEvent.delta.type === 'text_delta') {
            const textDelta = deltaEvent.delta as TextDelta;
            const content = textDelta.text || '';
            if (content) {
              yield { content, done: false, model: options.model };
            }
          }
        } else if (event.type === 'content_block_start') {
          // Standard streaming doesn't support tool_use in content_block_start
          // Tool calls will be handled differently or in the final response
        } else if (event.type === 'message_stop') {
          yield { 
            content: '', 
            done: true, 
            model: options.model,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined
          };
          return;
        }
      }
    } catch (error) {
      throw new Error(`Claude streaming error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private prepareMessages(options: LLMRequestOptions): { system?: string; messages: any[] } {
    let system = options.systemPrompt;
    const messages = options.messages.filter(m => m.role !== 'system');
    
    // Find system message if no explicit system prompt
    if (!system) {
      const systemMessage = options.messages.find(m => m.role === 'system');
      if (systemMessage) {
        system = systemMessage.content;
      }
    }
    
    // Convert messages to Claude format
    return {
      system,
      messages: messages.map(msg => {
        if (msg.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content
              }
            ]
          };
        }
        
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant',
            content: [
              ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
              ...msg.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: tc.function.arguments
              }))
            ]
          };
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        };
      })
    };
  }
}