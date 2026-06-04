export interface SecretsClient {
  get(key: string): Promise<string>;
  has(key: string): Promise<boolean>;
}
