/**
 * Next.js instrumentation entry point.
 * Next.js compiles this file for both Node.js and Edge runtimes.
 * Node-specific initialization is dynamically loaded only when NEXT_RUNTIME === "nodejs".
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    await registerNodeInstrumentation();
  }
}
