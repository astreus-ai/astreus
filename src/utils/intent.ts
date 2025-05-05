import { Plugin } from "../types/plugin";
import { logger } from "./index";
import { ProviderModel, ProviderMessage } from "../types";

/**
 * Intent recognition system that uses LLM to determine which tools should be used for a task
 * based on the task name and description.
 */
export class IntentRecognizer {
  /**
   * Use LLM to determine which tools are relevant for a task based on its name and description
   * 
   * @param taskName The name of the task
   * @param taskDescription The description of the task
   * @param availableTools Array of available tools
   * @param model The LLM to use for tool selection
   * @returns Array of tools that are relevant for the task
   */
  static async recognizeIntent(
    taskName: string,
    taskDescription: string,
    availableTools: Plugin[],
    model: ProviderModel
  ): Promise<Plugin[]> {
    // If no tools are available, return empty array
    if (!availableTools.length) {
      logger.debug(`No tools available for task "${taskName}"`);
      return [];
    }
    
    logger.info(`Using LLM to select tools for task "${taskName}"`);
    
    // Prepare tool information for the model
    const toolsInfo = availableTools.map(tool => ({
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || {}
    }));
    
    // Create the prompt for tool selection
    const prompt: ProviderMessage[] = [
      {
        role: "system",
        content: `You are a tool selection expert that picks the most relevant tools for a task.
Review the task and available tools and select ONLY the tools that are directly relevant.
Respond ONLY with a JSON array of tool names that should be used, without any explanation.
Example format: ["tool1", "tool2"]`
      },
      {
        role: "user",
        content: `Task name: ${taskName}
Task description: ${taskDescription}

Available tools:
${JSON.stringify(toolsInfo, null, 2)}

Select the most appropriate tools for this task and respond with a JSON array containing only the tool names.`
      }
    ];
    
    try {
      // Ask the model to select tools
      const response = await model.complete(prompt);
      
      // Extract JSON array from the response
      let toolNames: string[] = [];
      try {
        // Find the JSON array in the response
        const match = response.match(/\[.*\]/s);
        if (match) {
          toolNames = JSON.parse(match[0]);
        } else {
          throw new Error("No JSON array found in response");
        }
      } catch (error) {
        logger.error(`Failed to parse LLM tool selection response: ${error}`);
        logger.debug(`Raw LLM response: ${response}`);
        return []; // Return empty array on parsing error
      }
      
      // Map tool names to actual tool objects
      const selectedTools = toolNames
        .map(name => availableTools.find(tool => 
          tool.name.toLowerCase() === name.toLowerCase()))
        .filter(tool => tool !== undefined) as Plugin[];
      
      return selectedTools;
    } catch (error) {
      logger.error(`Error using LLM for tool selection: ${error}`);
      return []; // Return empty array on LLM error
    }
  }
} 