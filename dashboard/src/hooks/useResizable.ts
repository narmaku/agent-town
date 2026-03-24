import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "agentTown:panelSize:";

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
  side: "left" | "right" | "top" | "bottom";
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

function loadStoredSize(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch (_err) {
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

  const isVertical = side === "top" || side === "bottom";
  const clamp = useCallback((s: number) => Math.max(minSize, Math.min(maxSize, s)), [minSize, maxSize]);

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
      // For left/top panels, positive drag = larger. For right/bottom, negative drag = larger.
      const newSize = side === "left" || side === "top" ? startSizeRef.current + delta : startSizeRef.current - delta;
      setSize(clamp(newSize));
    }

    function handleMouseUp() {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      setSize((s) => {
        try {
          localStorage.setItem(STORAGE_PREFIX + storageKey, String(s));
        } catch (_err) {
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
    } catch (_err) {
      // localStorage unavailable
    }
  }, [defaultSize, storageKey]);

  return { size, isDragging, handleMouseDown, resetSize };
}
