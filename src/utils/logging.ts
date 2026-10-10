import { redact } from '../security/redaction';
/** `debug` is optional so simple loggers keep working; routine, high-frequency events belong there. */
export interface Logger { info(message: string): void; error(message: string): void; debug?(message: string): void }
export const silentLogger: Logger = { info: () => {}, error: () => {} };
export class SafeLogger implements Logger {
  constructor(private readonly append: (line: string) => void,
    private readonly level: () => string = () => 'info') {}
  info(message: string): void { if (['info', 'debug'].includes(this.level())) this.write(message); }
  debug(message: string): void { if (this.level() === 'debug') this.write(message); }
  error(message: string): void { if (this.level() !== 'off') this.write(message); }
  private write(message: string): void { this.append(`[${new Date().toISOString()}] ${redact(message)}`); }
}
