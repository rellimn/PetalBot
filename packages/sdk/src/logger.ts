export type LogData = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
  child(bindings: LogData): Logger;
}
