export type LayoutMode = "explorer" | "control" | "signal";

export function normalizeLayoutMode(value: unknown): LayoutMode {
  if (value === "explorer" || value === "control" || value === "signal") return value;
  return value === "cards" ? "control" : "explorer";
}
