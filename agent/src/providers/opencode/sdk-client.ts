import { createLogger } from "@agent-town/shared";

const log = createLogger("opencode:sdk");

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || "4096");
const OPENCODE_HOST = process.env.OPENCODE_HOST || "127.0.0.1";

type OpencodeClient = InstanceType<typeof import("@opencode-ai/sdk").OpencodeClient>;

let client: OpencodeClient | null = null;
let lastCheckMs = 0;

const RETRY_INTERVAL_MS = 30_000; // retry connection every 30s

/** Get or create the OpenCode SDK client. Returns null if server is not running. */
export async function getOpenCodeClient(): Promise<OpencodeClient | null> {
  // If we have a client, assume it's still valid (health is checked lazily)
  if (client) return client;

  // Don't hammer connection attempts
  if (Date.now() - lastCheckMs < RETRY_INTERVAL_MS) return null;
  lastCheckMs = Date.now();

  try {
    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    const c = createOpencodeClient({
      baseUrl: `http://${OPENCODE_HOST}:${OPENCODE_PORT}`,
    });

    // Test connection with health check
    const { data } = await c.global.health();
    if (data) {
      client = c;
      log.info(`connected to OpenCode server at ${OPENCODE_HOST}:${OPENCODE_PORT}`);
      return client;
    }
  } catch (err) {
    log.debug(
      `OpenCode server not available at ${OPENCODE_HOST}:${OPENCODE_PORT}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/** Reset the client (e.g., on error). */
export function resetOpenCodeClient(): void {
  client = null;
  lastCheckMs = 0;
}
