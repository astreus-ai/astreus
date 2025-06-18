export * from "./logger";
export * from "./intent";
export * from "./validation";

// Tool parameter conversion utility
export function convertToolParametersToSchema(tool: any): {
  name: string;
  description: string;
  parameters: any;
} {
  // Convert parameters to proper format for provider
  let formattedParameters = {};
  
  if (tool.parameters && Array.isArray(tool.parameters)) {
    // Convert array of parameter objects to JSON Schema properties
    const properties: Record<string, any> = {};
    const required: string[] = [];
    
    tool.parameters.forEach((param: any) => {
      if (param.name && param.type) {
        properties[param.name] = {
          type: param.type,
          description: param.description || `Parameter ${param.name}`
        };
        
        if (param.required) {
          required.push(param.name);
        }
      }
    });
    
    // Create proper JSON Schema
    formattedParameters = {
      type: "object",
      properties: properties
    };
    
    // Add required array if there are required parameters
    if (required.length > 0) {
      formattedParameters = {
        ...formattedParameters,
        required: required
      };
    }
  } else if (tool.parameters) {
    // Use parameters as-is if not an array
    formattedParameters = tool.parameters;
  }
  
  return {
    name: tool.name,
    description: tool.description || "",
    parameters: formattedParameters
  };
}