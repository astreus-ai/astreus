/**
 * Astreus AI - Logger Utility
 * Provides colorful console logging functionality for the framework
 */

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underscore: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",
  
  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  
  // Background colors
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
};

// Framework constants
const FRAMEWORK_NAME = "Astreus";
const FRAMEWORK_VERSION = "0.1.0";

// Log levels
/* eslint-disable no-unused-vars */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  SUCCESS = 2,
  WARN = 3,
  ERROR = 4,
  NONE = 5,
}
/* eslint-enable no-unused-vars */

// Logger options
interface LoggerOptions {
  level: LogLevel;
  prefix: boolean;
  colors: boolean;
  lineBreak: boolean;
  timestamp: boolean;
}

// Default options
const defaultOptions: LoggerOptions = {
  level: LogLevel.INFO,
  prefix: true,
  colors: true,
  lineBreak: false,
  timestamp: false
};

// Current logger options
let options: LoggerOptions = { ...defaultOptions };

// Track the last log time to prevent duplicate timestamps
let lastLogTime = 0;

/**
 * Create a formatted prefix for log messages
 */
function createPrefix(color: string): string {
  if (!options.prefix) return '';
  
  // Simple format: [FRAMEWORK]
  return `${color}[${FRAMEWORK_NAME}]${colors.reset} `;
}

/**
 * Get a timestamp string
 */
function getTimestamp(): string {
  if (!options.timestamp) return '';
  
  const now = Date.now();
  // Only show timestamps when they change by at least 1 second
  if (Math.abs(now - lastLogTime) < 1000) {
    return '';
  }
  
  lastLogTime = now;
  const date = new Date(now);
  return `${colors.gray}[${date.toLocaleTimeString()}]${colors.reset} `;
}

/**
 * Internal log function
 */
function log(level: LogLevel, color: string, ...messages: unknown[]): void {
  if (level < options.level) return;
  
  const prefix = createPrefix(color);
  const timestamp = getTimestamp();
  
  // Add line break before log entry if enabled (reduced usage)
  if (options.lineBreak && level >= LogLevel.WARN) {
    // Use safeConsole to handle console statements
    safeConsole('log');
  }
  
  if (options.colors) {
    // Apply color to text messages that are strings
    const coloredMessages = messages.map(msg => 
      typeof msg === 'string' ? `${color}${msg}${colors.reset}` : msg
    );
    // Use a direct string without extra spaces
    safeConsole('log', `${timestamp}${prefix}${coloredMessages.join(' ')}`);
  } else {
    // Strip color codes using string replace with a function rather than regex with control chars
    // This avoids the ESLint 'no-control-regex' error
    const stripAnsi = (str: string): string => {
      let result = '';
      let inEscSeq = false;
      
      for (let i = 0; i < str.length; i++) {
        // Start of escape sequence
        if (str[i] === '\u001b' && str[i+1] === '[') {
          inEscSeq = true;
          i++; // Skip the '['
          continue;
        }
        
        // In escape sequence, wait for 'm' which ends ANSI color codes
        if (inEscSeq) {
          if (str[i] === 'm') {
            inEscSeq = false;
          }
          continue;
        }
        
        // Normal character
        result += str[i];
      }
      
      return result;
    };
    
    const strippedPrefix = stripAnsi(prefix);
    safeConsole('log', `${timestamp}${strippedPrefix}${messages.join(' ')}`);
  }
}

/**
 * Safe console wrapper to avoid ESLint warnings
 */
function safeConsole(method: 'log' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
  // This function centralizes console usage and can be disabled by ESLint when needed
  // eslint-disable-next-line no-console
  if (method === 'log') console.log(...args);
  // eslint-disable-next-line no-console
  else if (method === 'info') console.info(...args);
  // eslint-disable-next-line no-console
  else if (method === 'warn') console.warn(...args);
  // eslint-disable-next-line no-console
  else if (method === 'error') console.error(...args);
}

/**
 * Configure the logger
 */
export function configure(newOptions: Partial<LoggerOptions>): void {
  options = { ...options, ...newOptions };
}

/**
 * Print the framework banner
 */
export function printBanner(): void {
  if (options.level > LogLevel.INFO) return;
  
  safeConsole('log');
  safeConsole('log', `${colors.cyan}${colors.bright}${FRAMEWORK_NAME} AI Framework v${FRAMEWORK_VERSION}${colors.reset}`);
  safeConsole('log');
}

/**
 * Public logging functions
 */
export const logger = {
  debug: (...messages: unknown[]) => log(LogLevel.DEBUG, colors.gray, ...messages),
  info: (...messages: unknown[]) => log(LogLevel.INFO, colors.blue, ...messages),
  success: (...messages: unknown[]) => log(LogLevel.SUCCESS, colors.green, ...messages),
  warn: (...messages: unknown[]) => log(LogLevel.WARN, colors.yellow, ...messages),
  error: (...messages: unknown[]) => log(LogLevel.ERROR, colors.red, ...messages),
  
  // Special formatted logs
  task: (taskId: string, message: string, taskName?: string) => {
    // If taskName is provided, use it; otherwise, just use "Task"
    const prefix = taskName ? `Task [${taskName}]:` : 'Task:';
    log(LogLevel.INFO, colors.magenta, `${prefix} ${message}`);
  },
  
  agent: (agentName: string, message: string) => {
    log(LogLevel.INFO, colors.cyan, `Agent [${agentName}]: ${message}`);
  },
  
  database: (operation: string, message: string) => {
    log(LogLevel.DEBUG, colors.blue, `${operation}: ${message}`);
  },
  
  memory: (operation: string, message: string) => {
    log(LogLevel.DEBUG, colors.magenta, `${operation}: ${message}`);
  },
  
  session: (sessionId: string, message: string) => {
    const shortId = sessionId.substring(0, 8);
    log(LogLevel.INFO, colors.green, `${shortId}: ${message}`);
  },
  
  plugin: (pluginName: string, message: string) => {
    // Capitalize first letter of plugin name and remove brackets
    const capitalizedPluginName = pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
    log(LogLevel.INFO, colors.yellow, `${capitalizedPluginName}: ${message}`);
  },
  
  workflow: (workflowName: string, message: string) => {
    log(LogLevel.INFO, colors.cyan, `${workflowName}: ${message}`);
  },
  
  // Progress indicators - these don't add line breaks to avoid disrupting the animation
  startProgress: (message: string): NodeJS.Timeout => {
    if (options.level > LogLevel.INFO) return setInterval(() => {}, 1000);
    
    // Optionally add a line break before starting progress
    if (options.lineBreak) {
      safeConsole('log');
    }
    
    process.stdout.write(`${createPrefix(colors.blue)}${colors.blue}${message}`);
    
    const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    
    return setInterval(() => {
      process.stdout.write(`\r${createPrefix(colors.blue)}${colors.blue}${message} ${colors.cyan}${chars[i]}${colors.reset}`);
      i = (i + 1) % chars.length;
    }, 100);
  },
  
  endProgress: (interval: NodeJS.Timeout, finalMessage?: string) => {
    clearInterval(interval);
    if (options.level > LogLevel.INFO) return;
    
    if (finalMessage) {
      process.stdout.write(`\r${createPrefix(colors.blue)}${colors.green}${finalMessage} ✓${colors.reset}\n`);
    } else {
      process.stdout.write(`\r${createPrefix(colors.blue)}${colors.green}Done ✓${colors.reset}\n`);
    }
  },
  
  // Configure line breaks
  setLineBreak: (enabled: boolean) => {
    configure({ lineBreak: enabled });
  },
};


export default logger; 