type Level = 'silent' | 'error' | 'warn' | 'info' | 'debug';
const RANK: Record<Level, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Minimal leveled logger; never throws. */
export class NexusLog {
  private static level: Level = 'warn';
  static configure(level: Level): void {
    NexusLog.level = level;
  }
  private static at(level: Level): boolean {
    return RANK[level] <= RANK[NexusLog.level];
  }
  static debug(msg: string): void {
    if (NexusLog.at('debug')) console.debug(`[Nexus] ${msg}`);
  }
  static info(msg: string): void {
    if (NexusLog.at('info')) console.info(`[Nexus] ${msg}`);
  }
  static warn(msg: string): void {
    if (NexusLog.at('warn')) console.warn(`[Nexus] ${msg}`);
  }
  static error(msg: string, err?: unknown): void {
    if (NexusLog.at('error')) console.error(`[Nexus] ${msg}`, err ?? '');
  }
  static mask(key: string): string {
    return key.length <= 8 ? '***' : `${key.slice(0, 6)}…${key.slice(-2)}`;
  }
}
