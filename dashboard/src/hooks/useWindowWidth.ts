import { useEffect, useState } from "react";

const RESIZE_DEBOUNCE_MS = 150;

/** Returns the current `window.innerWidth`, updating reactively on resize (debounced). */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function handleResize() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        setWidth(window.innerWidth);
        timeoutId = null;
      }, RESIZE_DEBOUNCE_MS);
    }
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);
  return width;
}
