export interface ConcurrencyLimiter {
  acquire(): Promise<() => void>;
  available(): number;
}
