import pino from 'pino';
import { Logger as ILogger, LoggerConfig, LogLevel, LogData } from './types';

export class Logger implements ILogger {
  private pino: pino.Logger;
  public config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    const envLevel = process.env.LOG_LEVEL as LogLevel;
    
    this.config = {
      level: envLevel || 'info',
      debug: config.debug || false,
      enableConsole: true,
      enableFile: false,
      ...config
    };

    // Create pino instance with pretty printing in development
    const isProduction = process.env.NODE_ENV === 'production';
    
    const pinoConfig: pino.LoggerOptions = {
      level: this.config.level === 'success' ? 'info' : this.config.level,
      formatters: {
        level: (label) => {
          return { level: label };
        }
      },
      base: {
        framework: 'Astreus'
      },
      timestamp: this.config.debug ? pino.stdTimeFunctions.isoTime : false
    };

    // Pretty print in development, JSON in production
    if (!isProduction && this.config.enableConsole) {
      this.pino = pino({
        ...pinoConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: false,
            ignore: 'pid,hostname,framework,level,time,module,agent,data,err',
            messageFormat: 'Astreus [{agent}] {module} → {msg}',
            customColors: 'info:blue,warn:yellow,error:red,success:green',
            hideObject: true,
            singleLine: false,
            messageKey: 'msg'
          }
        }
      });
    } else {
      this.pino = pino(pinoConfig);
    }
  }

  private formatLogObject(message: string, module: string = 'Core', data?: LogData, error?: Error, agentName?: string): Record<string, unknown> {
    const logObject: Record<string, unknown> = {
      msg: message,
      module,
      framework: 'Astreus',
      agent: agentName || this.config.agentName || 'System'
    };

    if (data) {
      logObject.data = data;
    }

    if (error) {
      logObject.err = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    }

    return logObject;
  }

  debug(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.debug(logObj);
  }

  info(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.info(logObj);
  }

  warn(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.warn(logObj);
  }

  error(message: string, error?: Error, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, error, agentName);
    this.pino.error(logObj);
  }

  success(message: string, data?: LogData, agentName?: string): void {
    // Pino doesn't have success level, use info with success marker
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    logObj.level = 'success';
    this.pino.info(logObj);
  }

  // Add a public log method for custom module names
  log(level: LogLevel, message: string, module: string = 'Core', data?: LogData, error?: Error, agentName?: string): void {
    const logObj = this.formatLogObject(message, module, data, error, agentName);
    
    switch(level) {
      case 'debug':
        this.pino.debug(logObj);
        break;
      case 'info':
      case 'success':
        this.pino.info(logObj);
        break;
      case 'warn':
        this.pino.warn(logObj);
        break;
      case 'error':
        this.pino.error(logObj);
        break;
    }
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
    this.pino.level = level === 'success' ? 'info' : level;
  }

  setDebug(debug: boolean): void {
    this.config.debug = debug;
    // Recreate logger with new debug setting
    const newLogger = new Logger({ ...this.config, debug });
    this.pino = newLogger.pino;
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

export function getLogger(config?: Partial<LoggerConfig>): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ agentName: 'System', ...config });
  }
  return globalLogger;
}

export function initializeLogger(config: Partial<LoggerConfig>): Logger {
  globalLogger = new Logger(config);
  return globalLogger;
}

export * from './types';