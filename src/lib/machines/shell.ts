/**
 * POSIX single-quote escaping for the one place a command line is built as
 * text: the SSM `machine.exec` escape hatch (AWS-RunShellScript takes a script,
 * not an argv vector).
 *
 * Inside single quotes every byte is literal, so `$`, backticks, `;`, `|`, `&`,
 * newlines, `*` and `\` stay inert. The only character that cannot appear
 * inside single quotes is the single quote itself; it is written as `'\''`
 * (close the quote, an escaped literal quote, reopen). NUL cannot be carried
 * in a shell word at all and is refused.
 */

export function shellQuote(arg: string): string {
  if (arg.includes("\0")) throw new Error("NUL cannot be passed in a shell word");
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** argv → one command line of quoted words joined by single spaces. */
export function argvToCommandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
