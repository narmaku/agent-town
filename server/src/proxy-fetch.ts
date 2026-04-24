import { createLogger, type WebSocketMessage } from "@agent-town/shared";

const log = createLogger("proxy");

/** Default timeout for data-read proxy requests (10 seconds) */
export const PROXY_TIMEOUT_MS = 10_000;

/** Longer timeout for agent launch/resume operations (30 seconds) */
export const PROXY_LAUNCH_TIMEOUT_MS = 30_000;

/** WebSocket connection timeout (10 seconds) */
export const WS_CONNECT_TIMEOUT_MS = 10_000;

interface ProxyFetchSuccess {
  ok: true;
  response: Response;
  status?: undefined;
  error?: undefined;
  message?: undefined;
}

interface ProxyFetchError {
  ok: false;
  response?: undefined;
  status: number;
  error: string;
  message: string;
}

type ProxyFetchResult = ProxyFetchSuccess | ProxyFetchError;

/**
 * Fetch wrapper that adds an AbortSignal.timeout to prevent hanging
 * when an agent machine becomes unreachable.
 *
 * Returns a discriminated union so callers can check `result.ok` to
 * determine if the fetch succeeded or timed out / failed.
 */
export async function proxyFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PROXY_TIMEOUT_MS,
): Promise<ProxyFetchResult> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, response };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      log.warn(`proxy timeout after ${timeoutMs}ms: ${url}`);
      return {
        ok: false,
        status: 504,
        error: "agent_timeout",
        message: `Agent did not respond within ${Math.round(timeoutMs / 1000)}s`,
      };
    }

    log.error(`proxy fetch failed: ${url} — ${errMsg}`);
    return {
      ok: false,
      status: 502,
      error: "agent_unreachable",
      message: errMsg,
    };
  }
}

type WsClient = { ws: unknown; send: (data: string) => void };

/**
 * Broadcast a WebSocket message to all connected dashboard clients.
 * Copies the Set before iterating to avoid issues with concurrent mutation
 * when a failed client is removed during the loop.
 */
export function broadcastToClients(wsClients: Set<WsClient>, message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  const clients = [...wsClients];
  for (const client of clients) {
    try {
      client.send(data);
    } catch (err) {
      log.debug(`broadcast: removing failed client: ${err instanceof Error ? err.message : String(err)}`);
      wsClients.delete(client);
    }
  }
}
