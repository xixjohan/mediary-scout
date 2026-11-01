export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export class McpCircuitBreaker {
  private _state: CircuitState = "CLOSED";
  private _failureCount = 0;
  private _lastFailureTime = 0;
  private readonly _failureThreshold: number;
  private readonly _cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this._failureThreshold = options.failureThreshold ?? 3;
    this._cooldownMs = options.cooldownMs ?? 30_000;
  }

  public getState(): CircuitState {
    if (this._state === "OPEN") {
      if (Date.now() - this._lastFailureTime >= this._cooldownMs) {
        return "HALF_OPEN";
      }
    }
    return this._state;
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "OPEN") {
      throw new Error(
        `[McpCircuitBreaker] 熔断器处于 OPEN 状态，由于连续 ${this._failureThreshold} 次失败已自动快速熔断，请在 ${Math.ceil((this._lastFailureTime + this._cooldownMs - Date.now()) / 1000)} 秒后再试。`
      );
    }

    try {
      const result = await action();
      // 成功恢复
      this._state = "CLOSED";
      this._failureCount = 0;
      return result;
    } catch (error) {
      this._failureCount += 1;
      this._lastFailureTime = Date.now();

      if (currentState === "HALF_OPEN" || this._failureCount >= this._failureThreshold) {
        this._state = "OPEN";
      }
      throw error;
    }
  }

  public reset(): void {
    this._state = "CLOSED";
    this._failureCount = 0;
    this._lastFailureTime = 0;
  }
}
