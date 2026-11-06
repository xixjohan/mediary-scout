export async function savePolicyBeforeAcquisition<T>(
  savePolicy: () => Promise<{ ok: boolean; error?: string }>,
  startAcquisition: () => Promise<T>,
): Promise<T> {
  const result = await savePolicy();
  if (!result.ok) {
    throw new Error(result.error || "订阅策略保存失败，未启动获取任务");
  }
  return startAcquisition();
}
