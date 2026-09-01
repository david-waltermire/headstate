/// A one-line, plain-text summary of a comment body, for the collapsed
/// title row of a comment nobody has expanded yet.
///
/// The title row is the ONLY thing distinguishing two comments by the same
/// author on the same day, so it has to carry actual content -- but it also
/// has to survive whatever markdown the body opens with.
///
/// `body.slice(0, n)` is what this exists instead of. A comment that opens
/// with a heading previews as "###", one that opens with a fenced block
/// previews as "```", and one that opens with a blank line previews as
/// nothing at all -- three common shapes that all produce a row saying
/// nothing.
export function commentPreview(body: string, max = 80): string {
  // The first line with real content, not the first line. Bodies routinely
  // open with a blank line, a heading, or a fence, none of which say
  // anything about what the comment IS.
  const line = body
    .split("\n")
    .map((l) => stripMarkdown(l))
    .find((l) => l.length > 0);

  if (line === undefined) return "";
  // Ellipsis only when something was actually cut. Appending it
  // unconditionally implies every preview is truncated, which makes a
  // short complete comment look like it continues.
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

/// Renders inline markdown as the text a person reads.
///
/// The preview sits in a title row as PLAIN text -- it is deliberately not
/// passed through the markdown renderer, because a `**bold**` fragment or a
/// half-open link in a truncated line would inject formatting into a row
/// that has to stay one line tall.
function stripMarkdown(line: string): string {
  return (
    line
      // Fences and block quotes carry no content of their own.
      .replace(/^\s*(?:```+|~~~+).*$/, "")
      .replace(/^\s*>+\s?/, "")
      // Leading markers: heading hashes, list bullets, numbered items,
      // and task boxes. The TEXT after them is the useful part.
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      // Images before links: an image is `![alt](url)` and the link rule
      // would otherwise leave a stray `!` behind.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis and code spans, keeping the text inside.
      .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/`+([^`]+)`+/g, "$1")
      // Collapse runs of whitespace so a line padded for alignment in the
      // source does not render as a gap in the title row.
      .replace(/\s+/g, " ")
      .trim()
  );
}
