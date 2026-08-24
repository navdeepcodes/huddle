/**
 * Phase 25: npm's own spinner/progress-bar output is dominated by ANSI
 * cursor-control escape sequences (confirmed live, repeatedly, e.g. a
 * real `npm install` transcript: long runs of
 * `\x1b[1G\x1b[0K\\x1b[1G\x1b[0K|...`) - pure noise, zero
 * decision-relevant content, that was previously eating into the same
 * fixed character budget (executeTool.ts's tail-truncation) as the
 * actual output the model needs to read (real errors, exit summaries).
 * Stripping these first means the truncation budget is spent on signal.
 * Matches SGR color codes, cursor movement, and erase-line/screen
 * sequences - the actual codes observed in real command output, not a
 * general-purpose terminal emulator.
 */
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Carriage-return-only redraws (a spinner overwriting the same line
// without a full ANSI sequence) - collapse to the last thing written on
// that line, same as a real terminal would show.
const CR_REDRAW_RE = /[^\n]*\r(?!\n)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(CR_REDRAW_RE, "");
}
