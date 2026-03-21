import type { AgentType } from "@agent-town/shared";
import { createLogger } from "@agent-town/shared";
import type { AgentProvider } from "./types";

const log = createLogger("registry");

const providers = new Map<AgentType, AgentProvider>();

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.type, provider);
  log.info(`registered provider: ${provider.displayName} (${provider.type})`);
}

export function getProvider(type: AgentType): AgentProvider | undefined {
  return providers.get(type);
}

export function getAllProviders(): AgentProvider[] {
  return [...providers.values()];
}

/** Detect which agent binaries are available and register their providers. */
export async function initializeProviders(): Promise<void> {
  // Lazy imports to avoid circular deps
  const { ClaudeCodeProvider } = await import("./claude-code/index");
  const { OpenCodeProvider } = await import("./opencode/index");
  const { GeminiCliProvider } = await import("./gemini-cli/index");

  const candidates: AgentProvider[] = [new ClaudeCodeProvider(), new OpenCodeProvider(), new GeminiCliProvider()];

  for (const provider of candidates) {
    const available = await provider.isAvailable();
    if (available) {
      registerProvider(provider);
    } else {
      log.info(`provider not available: ${provider.displayName} (${provider.binaryName} not found)`);
    }
  }

  if (providers.size === 0) {
    log.warn("no agent providers available — no sessions will be discovered");
  }
}

/** Clear all providers (for testing). */
export function clearProviders(): void {
  providers.clear();
}
