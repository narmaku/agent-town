/** Split the launch field into literal arguments, honoring quotes and backslashes. */
export function parseLaunchArguments(input: string): string[] {
  const args: string[] = [];
  let word: string | undefined;
  let quote: "" | "'" | '"' = "";

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (!quote && (character === " " || character === "\t")) {
      if (word !== undefined) args.push(word);
      word = undefined;
      continue;
    }

    word ??= "";
    if (character === quote) {
      quote = "";
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character;
    } else if (character === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next === undefined) throw new Error("Complete the backslash escape in the extra arguments.");
      if (!quote || ['"', "\\", "$", "`"].includes(next)) {
        word += next;
        index++;
      } else {
        word += character;
      }
    } else {
      word += character;
    }
  }

  if (quote) throw new Error("Close the quote in the extra arguments.");
  if (word !== undefined) args.push(word);
  return args;
}

/** Validate argv before it can be typed into a multiplexer pane. */
export function resolveExtraLaunchArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string" && !/\p{Cc}/u.test(arg))) {
    throw new Error("extraArgs must be an array of strings without control characters");
  }
  return value;
}
