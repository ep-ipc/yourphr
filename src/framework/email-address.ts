/**
 * What counts as one email address here (yourphr#536, #792). Deliberately plain: one address, no
 * display name, no list — the relay has the last word on whether it exists. Shared by the mail
 * manager (recipients, sender) and the users manager (an account's own address), so the two cannot
 * disagree about what an address is.
 */
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isEmailAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/** The address inside "Name <addr>", or the whole string trimmed. */
export function addressOf(from: string): string {
  return /<([^>]+)>\s*$/.exec(from)?.[1]?.trim() ?? from.trim();
}
