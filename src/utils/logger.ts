/**
 * Astreus AI - Logger Utility
 * Provides colorful console logging functionality for the framework
 */

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  
  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

// Framework constants
const FRAMEWORK_NAME = "Astreus";

// Log levels
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  SUCCESS = 2,
  WARN = 3,
  ERROR = 4,
  NONE = 5,
}

// Logger options
interface LoggerOptions {
  level: LogLevel;
  colors: boolean;
}

// Default options
const defaultOptions: LoggerOptions = {
  level: LogLevel.INFO,
  colors: true,
};

// Current options
const currentOptions = { ...defaultOptions };

/**
 * Get color wrapper function
 */
function getColor(color: keyof typeof colors): (text: string) => string {
  return (text: string) => {
    if (!currentOptions.colors) return text;
    return `${colors[color]}${text}${colors.reset}`;
  };
}

/**
 * Convert any value to string for logging
 */
function toString(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Format the main log message with consistent styling
 */
function formatMessage(agentName: string, component: string, message: string, messageColor: (text: string) => string): string {
  const frameworkColor = getColor("cyan");
  const agentColor = getColor("bright");
  const componentColor = getColor("blue");
  const arrowColor = getColor("gray");
  
  return `${frameworkColor(FRAMEWORK_NAME)} ${agentColor(`[${agentName}]`)} ${componentColor(component)} ${arrowColor("→")} ${messageColor(message)}`;
}

/**
 * Generic log function with level check
 */
function log(
  level: LogLevel, 
  colorFn: (text: string) => string,
  agentNameOrMessage: any, 
  componentOrUndefined?: any, 
  messageOrUndefined?: any
): void {
  if (currentOptions.level > level) return;

  let formattedMessage: string;

  if (componentOrUndefined !== undefined && messageOrUndefined !== undefined) {
    // New format: agentName, component, message - use consistent formatting
    formattedMessage = formatMessage(
      toString(agentNameOrMessage), 
      toString(componentOrUndefined), 
      toString(messageOrUndefined),
      colorFn // Pass the color function for the message part
    );
  } else {
    // Legacy format: just message - apply color to entire message
    formattedMessage = colorFn(toString(agentNameOrMessage));
  }

  console.log(formattedMessage);
}

/**
 * Astreus Logger Interface
 */
export const logger = {
  /**
   * Debug logging - for development information
   */
  debug: (agentNameOrMessage: any, component?: any, message?: any) => 
    log(LogLevel.DEBUG, getColor("gray"), agentNameOrMessage, component, message),

  /**
   * Info logging - for general information
   */
  info: (agentNameOrMessage: any, component?: any, message?: any) => 
    log(LogLevel.INFO, getColor("blue"), agentNameOrMessage, component, message),

  /**
   * Success logging - for successful operations
   */
  success: (agentNameOrMessage: any, component?: any, message?: any) => 
    log(LogLevel.SUCCESS, getColor("green"), agentNameOrMessage, component, message),

  /**
   * Warning logging - for potential issues
   */
  warn: (agentNameOrMessage: any, component?: any, message?: any) => 
    log(LogLevel.WARN, getColor("yellow"), agentNameOrMessage, component, message),

  /**
   * Error logging - for errors and exceptions
   */
  error: (agentNameOrMessage: any, component?: any, message?: any) => 
    log(LogLevel.ERROR, getColor("red"), agentNameOrMessage, component, message),

  /**
   * Set logging level
   */
  setLevel: (level: LogLevel) => {
    currentOptions.level = level;
  },

  /**
   * Enable/disable colors
   */
  setColors: (enabled: boolean) => {
    currentOptions.colors = enabled;
  },

  /**
   * Get current options
   */
  getOptions: () => ({ ...currentOptions }),
};

export default logger; 