/**
 * 品牌限速装饰器（任务单 S3.3，P13：并发风暴触发封号）。
 *
 * 网盘 client 的每一次 API 调用前先过品牌限速器（治理文档参数：115 漏桶
 * 1.2s/发、夸克令牌桶 3/s burst 5；见 packages/shared/rate-limiter.ts）。
 * 只包 pacing：返回值、this 绑定、非方法属性全部原样。未登记品牌零包装
 * （返回同一对象），新网盘接入默认不加限。
 */
import { createBrandPacer, type PacerDeps } from "@media-track/shared";

export function withBrandPacing<T extends object>(client: T, brand: string, deps: PacerDeps): T {
  const pacer = createBrandPacer(brand, deps);
  if (pacer.kind === "noop") {
    return client;
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        await pacer.wait();
        return (value as (...fnArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}
