import { createLogger, type WebSocketMessage } from "@agent-town/shared";
import { authHeaders } from "@agent-town/shared/request-guard";

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

/**
 * proxyFetch to an agent, presenting the shared token. An agent that rejects
 * the token yields a 502 (not a 401), so the dashboard does not mistake it
 * for its own credentials being wrong.
 */
export async function agentProxyFetch(
  url: string,
  token: string,
  init: RequestInit = {},
  timeoutMs: number = PROXY_TIMEOUT_MS,
): Promise<ProxyFetchResult> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders(token))) headers.set(key, value);
  const result = await proxyFetch(url, { ...init, headers }, timeoutMs);
  if (result.ok && result.response.status === 401) {
    log.error(`agent rejected the access token: ${url}`);
    return {
      ok: false,
      status: 502,
      error: "agent_unauthorized",
      message: "Agent rejected the server's access token — both must use the same ~/.agent-town/token",
    };
  }
  return result;
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
