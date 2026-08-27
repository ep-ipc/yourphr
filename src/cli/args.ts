/**
 * Argument helpers for the subcommand layer (yourphr#654).
 *
 * Hand-rolled, and deliberately so: the whole surface is four commands and eight flags. A parsing
 * library would be a dependency shipped in the image to save thirty lines, and the image is the
 * thing this issue is about.
 *
 * The rule these exist to serve: a flag the command does not recognise is an ERROR, never a
 * silently-ignored word. Every flag here either names a data directory or scopes what is written,
 * so `--go-dir` accepted as a typo for `--go-data` would run a migration against a default nobody
 * chose — the outcome yourphr#654 calls the worst available.
 */

/** The value after `--name`, or undefined when the flag is absent. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Whether a valueless flag is present. */
export function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * The `--flags` this command does not know, in the order they were given.
 *
 * `valued` flags consume the word after them, so that word is skipped rather than examined — a
 * value that itself begins with `--` is a value, not a flag. Anything left starting with `--` is
 * unknown, and the caller refuses.
 */
export function unknownFlags(argv: string[], valued: readonly string[], valueless: readonly string[]): string[] {
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (!word.startsWith('--')) continue;
    if (valued.includes(word)) { i++; continue; }
    if (valueless.includes(word)) continue;
    unknown.push(word);
  }
  return unknown;
}
