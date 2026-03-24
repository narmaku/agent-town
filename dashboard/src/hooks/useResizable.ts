import { useCallback, useEffect, useRef, useState } from "react";

export const STORAGE_PREFIX = "agentTown:panelSize:";

type PanelSide = "left" | "right" | "top" | "bottom";

interface UseResizableOptions {
  /** localStorage key suffix for persisting size */
  storageKey: string;
  /** Default size in pixels */
  defaultSize: number;
  /** Minimum allowed size in pixels */
  minSize: number;
  /** Maximum allowed size in pixels */
  maxSize: number;
  /** Which side/edge the panel is on — determines drag direction */
  side: PanelSide;
}

interface UseResizableResult {
  /** Current panel size (width for horizontal, height for vertical) */
  size: number;
  /** Whether the user is currently dragging */
  isDragging: boolean;
  /** Attach this to the drag handle element via onMouseDown */
  handleMouseDown: (e: React.MouseEvent) => void;
  /** Reset size to default */
  resetSize: () => void;
}

/** Clamp a value between min and max bounds. */
export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Determine whether a panel side uses vertical (Y-axis) dragging. */
export function isVerticalSide(side: PanelSide): boolean {
  return side === "top" || side === "bottom";
}

/** Compute new panel size from a drag delta, accounting for panel side direction. */
export function computeNewSize(startSize: number, delta: number, side: PanelSide): number {
  return side === "left" || side === "top" ? startSize + delta : startSize - delta;
}

export function loadStoredSize(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // localStorage unavailable
  }
  return fallback;
}

export function useResizable({
  storageKey,
  defaultSize,
  minSize,
  maxSize,
  side,
}: UseResizableOptions): UseResizableResult {
  const [size, setSize] = useState(() => loadStoredSize(storageKey, defaultSize));
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const isVertical = isVerticalSide(side);
  const clamp = useCallback((s: number) => clampValue(s, minSize, maxSize), [minSize, maxSize]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      setIsDragging(true);
      startPosRef.current = isVertical ? e.clientY : e.clientX;
      startSizeRef.current = size;
    },
    [size, isVertical],
  );

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current) return;
      const pos = isVertical ? e.clientY : e.clientX;
      const delta = pos - startPosRef.current;
      const newSize = computeNewSize(startSizeRef.current, delta, side);
      setSize(clamp(newSize));
    }

    function handleMouseUp() {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      setSize((s) => {
        try {
          localStorage.setItem(STORAGE_PREFIX + storageKey, String(s));
        } catch {
          // localStorage unavailable
        }
        return s;
      });
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clamp, side, storageKey, isVertical]);

  const resetSize = useCallback(() => {
    setSize(defaultSize);
    try {
      localStorage.removeItem(STORAGE_PREFIX + storageKey);
    } catch {
      // localStorage unavailable
    }
  }, [defaultSize, storageKey]);

  return { size, isDragging, handleMouseDown, resetSize };
}
