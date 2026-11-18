import type { Terminal } from "@xterm/xterm";

/**
 * Resize the terminal to fill its parent element. Replaces @xterm/addon-fit
 * using the same calculation. xterm.js has no public API for the rendered cell
 * size, so this reads the renderer's dimensions like the official addon does;
 * keep @xterm/xterm pinned to an exact version so this stays in sync.
 */
const MIN_COLS = 2;
const MIN_ROWS = 1;
const DEFAULT_SCROLLBAR_WIDTH = 14;

interface CellSize {
  width: number;
  height: number;
}

interface RenderService {
  dimensions?: { css?: { cell?: CellSize } };
  clear?: () => void;
}

function renderService(term: Terminal): RenderService | undefined {
  return (term as unknown as { _core?: { _renderService?: RenderService } })._core?._renderService;
}

function px(style: CSSStyleDeclaration, property: string): number {
  return parseInt(style.getPropertyValue(property), 10) || 0;
}

export function fitTerminal(term: Terminal): void {
  const element = term.element;
  const parent = element?.parentElement;
  const service = renderService(term);
  const cell = service?.dimensions?.css?.cell;
  if (!element || !parent || !cell || cell.width === 0 || cell.height === 0) return;

  const parentStyle = window.getComputedStyle(parent);
  const style = window.getComputedStyle(element);
  const scrollbar = term.options.scrollback === 0 ? 0 : (term.options.overviewRuler?.width ?? DEFAULT_SCROLLBAR_WIDTH);
  const width =
    Math.max(0, px(parentStyle, "width")) - px(style, "padding-left") - px(style, "padding-right") - scrollbar;
  const height = px(parentStyle, "height") - px(style, "padding-top") - px(style, "padding-bottom");
  const cols = Math.max(MIN_COLS, Math.floor(width / cell.width));
  const rows = Math.max(MIN_ROWS, Math.floor(height / cell.height));
  if (Number.isNaN(cols) || Number.isNaN(rows) || (cols === term.cols && rows === term.rows)) return;

  service?.clear?.();
  term.resize(cols, rows);
}
