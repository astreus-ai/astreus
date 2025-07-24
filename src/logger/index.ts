import { Logger as ILogger, LoggerConfig, LogLevel, LogEntry, LogData } from './types';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export class Logger implements ILogger {
  public config: LoggerConfig;
  public logLevels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    success: 1,
    warn: 2,
    error: 3
  };

  constructor(config: Partial<LoggerConfig> = {}) {
    const envLevel = process.env.LOG_LEVEL as LogLevel;
    
    this.config = {
      level: envLevel || 'info',
      debug: config.debug || false,
      enableConsole: true,
      enableFile: false,
      ...config
    };
  }

  public shouldLog(level: LogLevel): boolean {
    return this.logLevels[level] >= this.logLevels[this.config.level];
  }

  private getColorForLevel(level: LogLevel): (text: string) => string {
    // Fallback if chalk is not available
    if (!chalk) {
      return (text: string) => text;
    }
    
    switch (level) {
      case 'debug': return chalk.gray || ((text: string) => text);
      case 'info': return chalk.blue || ((text: string) => text);
      case 'success': return chalk.green || ((text: string) => text);
      case 'warn': return chalk.yellow || ((text: string) => text);
      case 'error': return chalk.red || ((text: string) => text);
      default: return chalk.white || ((text: string) => text);
    }
  }

  public formatMessage(entry: LogEntry, agentName?: string): string {
    const colorFn = this.getColorForLevel(entry.level);
    const component = entry.module || 'Core';
    
    // Professional format: "Astreus [AgentName] Component → Message"
    // Use provided agentName or fall back to stored agentName in config
    const resolvedAgentName = agentName || this.config.agentName;
    let baseFormat: string;
    if (resolvedAgentName) {
      baseFormat = `Astreus [${resolvedAgentName}] ${component} → ${entry.message}`;
    } else {
      baseFormat = `Astreus ${component} → ${entry.message}`;
    }
    
    // Ensure colorFn is a function
    const safeColorFn = typeof colorFn === 'function' ? colorFn : (text: string) => text;
    
    if (this.config.debug) {
      const timestamp = entry.timestamp.toISOString();
      let message = safeColorFn(`[${timestamp}] ${baseFormat}`);
      
      if (entry.data) {
        const dimFn = (chalk && chalk.dim) ? chalk.dim : (text: string) => text;
        message += `\n${dimFn('Data:')} ${JSON.stringify(entry.data, null, 2)}`;
      }
      
      if (entry.error) {
        const redFn = (chalk && chalk.red) ? chalk.red : (text: string) => text;
        message += `\n${redFn('Error:')} ${entry.error.message}`;
        if (entry.error.stack) {
          message += `\n${redFn('Stack:')} ${entry.error.stack}`;
        }
      }
      
      return message;
    } else {
      return safeColorFn(baseFormat);
    }
  }

  public log(level: LogLevel, message: string, module: string = 'Core', data?: LogData, error?: Error, agentName?: string): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      module,
      timestamp: new Date(),
      data,
      error
    };

    const formattedMessage = this.formatMessage(entry, agentName);

    if (this.config.enableConsole) {
      // Use console.log for all levels to preserve colors
      console.log(formattedMessage);
    }

    if (this.config.enableFile && this.config.filePath) {
      // Strip colors for file output
      // eslint-disable-next-line no-control-regex
      const fileMessage = this.formatMessage(entry, agentName).replace(/\u001B\[[0-9;]*m/g, '');
      this.writeToFile(fileMessage);
    }
  }

  public writeToFile(formattedMessage: string): void {
    try {
      if (this.config.filePath) {
        const dir = path.dirname(this.config.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.appendFileSync(this.config.filePath, formattedMessage + '\n');
      }
    } catch (error) {
      console.error('[Logger] Failed to write to file:', error);
    }
  }

  debug(message: string, data?: LogData, agentName?: string): void {
    this.log('debug', message, 'Core', data, undefined, agentName);
  }

  info(message: string, data?: LogData, agentName?: string): void {
    this.log('info', message, 'Core', data, undefined, agentName);
  }

  warn(message: string, data?: LogData, agentName?: string): void {
    this.log('warn', message, 'Core', data, undefined, agentName);
  }

  error(message: string, error?: Error, data?: LogData, agentName?: string): void {
    this.log('error', message, 'Core', data, error, agentName);
  }

  success(message: string, data?: LogData, agentName?: string): void {
    this.log('success', message, 'Core', data, undefined, agentName);
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  setDebug(debug: boolean): void {
    this.config.debug = debug;
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

export function getLogger(config?: Partial<LoggerConfig>): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(config);
  }
  return globalLogger;
}

export function initializeLogger(config: Partial<LoggerConfig>): Logger {
  globalLogger = new Logger(config);
  return globalLogger;
}

export * from './types';