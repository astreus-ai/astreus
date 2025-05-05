/**
 * Utility functions for parameter validation
 */

/**
 * Validates that all required parameters are provided
 * @param params The parameters object to validate
 * @param requiredParams Array of parameter names that are required
 * @param functionName Name of the function for error message context
 * @throws Error if any required parameter is missing or undefined
 */
export function validateRequiredParams(
  params: Record<string, any>,
  requiredParams: string[],
  functionName: string
): void {
  // First check that params is actually an object
  if (!params || typeof params !== 'object') {
    throw new Error(`Invalid parameters object for ${functionName}: expected an object but got ${typeof params}`);
  }
  
  const missingParams: string[] = [];
  
  for (const param of requiredParams) {
    if (param in params) {
      // Parameter exists in the object, check if it's undefined or null
      if (params[param] === undefined || params[param] === null) {
        missingParams.push(param);
      }
    } else {
      // Parameter doesn't exist in the object at all
      missingParams.push(param);
    }
  }
  
  if (missingParams.length > 0) {
    throw new Error(
      `Missing required parameter${missingParams.length > 1 ? 's' : ''} for ${functionName}: ${missingParams.join(', ')}`
    );
  }
}

/**
 * Validates a single required parameter
 * @param value The parameter value to check
 * @param paramName Name of the parameter for error message
 * @param functionName Name of the function for error message context
 * @throws Error if the parameter is missing or undefined
 */
export function validateRequiredParam(
  value: any,
  paramName: string,
  functionName: string
): void {
  if (value === undefined || value === null) {
    throw new Error(`Missing required parameter '${paramName}' for ${functionName}`);
  }
} 