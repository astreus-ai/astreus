import { BaseAgent } from '../base';
import { getPlugin } from '../../plugin';
import { Plugin as IPlugin, PluginConfig, ToolCall, ToolCallResult, ToolContext } from '../../plugin/types';

export function withPlugins(BaseClass: typeof BaseAgent) {
  class PluginAgent extends BaseClass {
    public plugin = getPlugin();

    // Plugin management methods
    async registerPlugin(plugin: IPlugin, config?: PluginConfig): Promise<void> {
      await this.plugin.registerPlugin(plugin, config);
    }

    async unregisterPlugin(name: string): Promise<void> {
      await this.plugin.unregisterPlugin(name);
    }

    getPlugin(name: string): IPlugin | undefined {
      return this.plugin.getPlugin(name);
    }

    listPlugins(): IPlugin[] {
      return this.plugin.listPlugins();
    }

    // Tool management methods
    getTools() {
      return this.plugin.getTools();
    }

    getTool(name: string) {
      return this.plugin.getTool(name);
    }

    getToolsForLLM() {
      return this.plugin.getToolsForLLM();
    }

    // Tool execution
    async executeToolCall(toolCall: ToolCall, context?: Partial<ToolContext>): Promise<ToolCallResult> {
      const toolContext: ToolContext = {
        agentId: this.getId(),
        ...context
      };
      
      return this.plugin.executeToolCall(toolCall, toolContext);
    }

    async executeToolCalls(toolCalls: ToolCall[], context?: Partial<ToolContext>): Promise<ToolCallResult[]> {
      const results: ToolCallResult[] = [];
      
      for (const toolCall of toolCalls) {
        const result = await this.executeToolCall(toolCall, context);
        results.push(result);
      }
      
      return results;
    }

    // Enhanced task execution with tool support
    async executeTaskWithTools(
      prompt: string, 
      options?: {
        enableTools?: boolean;
        allowedTools?: string[];
        maxToolCalls?: number;
        stream?: boolean;
      }
    ): Promise<{
      response: string;
      toolCalls?: ToolCallResult[];
      model?: string;
      usage?: any;
    }> {
      const {
        enableTools = true,
        allowedTools,
        maxToolCalls = 10,
        stream = false
      } = options || {};

      // Get available tools for LLM
      let tools: any[] = [];
      if (enableTools) {
        const allTools = this.getToolsForLLM();
        tools = allowedTools 
          ? allTools.filter(tool => allowedTools.includes(tool.function.name))
          : allTools;
      }

      const { getLLM } = await import('../../llm');
      const llm = getLLM();

      const conversation = [{ role: 'user', content: prompt }];
      const allToolCalls: ToolCallResult[] = [];
      let totalToolCalls = 0;

      while (totalToolCalls < maxToolCalls) {
        const response = await llm.generateResponse({
          model: this.getModel() || 'gpt-4o',
          messages: conversation as any,
          temperature: this.getTemperature() || 0.7,
          maxTokens: this.getMaxTokens() || 4096,
          tools: tools.length > 0 ? tools : undefined,
          stream
        });

        // Add assistant response to conversation
        conversation.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls
        } as any);

        // If no tool calls, we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          return {
            response: response.content,
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            model: response.model,
            usage: response.usage
          };
        }

        // Execute tool calls
        const toolCallResults: ToolCallResult[] = [];
        for (const toolCall of response.toolCalls) {
          const result = await this.executeToolCall({
            id: toolCall.id,
            name: toolCall.function.name,
            parameters: toolCall.function.arguments
          });
          
          toolCallResults.push(result);
          allToolCalls.push(result);

          // Add tool result to conversation
          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result.result)
          } as any);
        }

        totalToolCalls += response.toolCalls.length;

        // If we've hit the max tool calls, break
        if (totalToolCalls >= maxToolCalls) {
          break;
        }
      }

      // Get final response after tool calls
      const finalResponse = await llm.generateResponse({
        model: this.getModel() || 'gpt-4o',
        messages: conversation as any,
        temperature: this.getTemperature() || 0.7,
        maxTokens: this.getMaxTokens() || 4096,
        stream
      });

      return {
        response: finalResponse.content,
        toolCalls: allToolCalls,
        model: finalResponse.model,
        usage: finalResponse.usage
      };
    }
  }

  return PluginAgent;
}