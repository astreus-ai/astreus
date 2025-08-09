export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

/**
 * Primitive values that can be logged
 */
export type LogDataPrimitive = string | number | boolean | null | Date;

/**
 * Complex log data that can contain primitives, arrays, or nested objects
 */
export type LogData = LogDataPrimitive | LogDataPrimitive[] | { [key: string]: LogData };

export interface LogEntry {
  level: LogLevel;
  message: string;
  module: string;
  timestamp: Date;
  data?: LogData;
  error?: Error;
}

export interface LoggerConfig {
  level: LogLevel;
  debug: boolean;
  enableConsole: boolean;
  enableFile?: boolean;
  filePath?: string;
  maxFileSize?: number;
  maxFiles?: number;
  agentName?: string;
}

export interface Logger {
  debug(message: string, data?: LogData, agentName?: string): void;
  info(message: string, data?: LogData, agentName?: string): void;
  warn(message: string, data?: LogData, agentName?: string): void;
  error(message: string, error?: Error, data?: LogData, agentName?: string): void;
  success(message: string, data?: LogData, agentName?: string): void;
  log(
    level: LogLevel,
    message: string,
    module: string,
    data?: LogData,
    error?: Error,
    agentName?: string
  ): void;
  setLevel(level: LogLevel): void;
  setDebug(debug: boolean): void;
}
