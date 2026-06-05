export const TAB = "\x09";
export const ESCAPE = "\x1b";
export const ENTER = "\r";
export const ALT_PREFIX = "\x1b";

const ARROW_CODES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

const SPECIAL_KEYS: Record<string, string> = {
  escape: ESCAPE,
  tab: TAB,
  enter: ENTER,
  up: ARROW_CODES.up,
  down: ARROW_CODES.down,
  left: ARROW_CODES.left,
  right: ARROW_CODES.right,
};

export function ctrlCode(key: string): string {
  if (key.length !== 1) return "";
  const lower = key.toLowerCase();
  const code = lower.charCodeAt(0);
  if (code < 97 || code > 122) return "";
  return String.fromCharCode(code - 96);
}

export function altCode(key: string): string {
  return ALT_PREFIX + key;
}

export function arrowCode(direction: "up" | "down" | "left" | "right"): string {
  return ARROW_CODES[direction];
}

export function parseKeyCombo(combo: string): string {
  if (!combo) return "";

  const lower = combo.toLowerCase().trim();

  if (SPECIAL_KEYS[lower]) {
    return SPECIAL_KEYS[lower];
  }

  const parts = combo.split("+").map((p) => p.trim());

  const modifiers = new Set<string>();
  let key = "";

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === "ctrl" || lowerPart === "alt" || lowerPart === "shift") {
      modifiers.add(lowerPart);
    } else {
      key = part;
    }
  }

  if (!key) return "";

  const keyLower = key.toLowerCase();

  if (SPECIAL_KEYS[keyLower]) {
    if (modifiers.has("ctrl")) {
      return ctrlCode(keyLower) || SPECIAL_KEYS[keyLower];
    }
    if (modifiers.has("alt")) {
      return altCode(SPECIAL_KEYS[keyLower]);
    }
    return SPECIAL_KEYS[keyLower];
  }

  if (modifiers.has("ctrl")) {
    const result = ctrlCode(key);
    if (result) return result;
  }

  if (modifiers.has("alt")) {
    return altCode(key.toLowerCase());
  }

  return "";
}
