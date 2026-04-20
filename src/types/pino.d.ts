declare module 'pino' {
  export interface Logger {
    child(bindings?: Record<string, unknown>): Logger;
    trace(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    fatal(...args: unknown[]): void;
  }

  const pino: unknown;
  export default pino;
}