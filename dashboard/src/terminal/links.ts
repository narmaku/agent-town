import type { IDisposable, Terminal } from "@xterm/xterm";

/** Replaces @xterm/addon-web-links: makes http(s) URLs in the terminal clickable. */
const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const TRAILING_PUNCTUATION_RE = /[.,:;!?)\]}]+$/;

export interface LinkMatch {
  /** 0-based string index of the first character. */
  index: number;
  url: string;
}

export function findLinks(line: string): LinkMatch[] {
  return [...line.matchAll(URL_RE)].map((match) => {
    let url = match[0].replace(TRAILING_PUNCTUATION_RE, "");
    // Keep a closing paren that balances one inside the URL, e.g. wiki links.
    const trailing = match[0].slice(url.length);
    if (trailing.startsWith(")") && url.split("(").length > url.split(")").length) url += ")";
    return { index: match.index ?? 0, url };
  });
}

export function registerLinks(term: Terminal): IDisposable {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = findLinks(line).map(({ index, url }) => ({
        range: { start: { x: index + 1, y }, end: { x: index + url.length, y } },
        text: url,
        activate(event: MouseEvent, text: string) {
          event.preventDefault();
          window.open(text, "_blank", "noopener,noreferrer");
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });
}
