/** Address services bind to by default: loopback only, never the LAN. */
export const LOOPBACK_HOST = "127.0.0.1";
/** Bind-all address, for setups where the server and agents talk over the LAN. */
export const ALL_INTERFACES_HOST = "0.0.0.0";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);

/** True when a hostname or IP refers to this machine's loopback interface. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.has(host.toLowerCase()) || host.startsWith("127.");
}
