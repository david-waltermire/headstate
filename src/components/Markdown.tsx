import { ExternalLink } from "./ExternalLink";
import rehypeSanitize from "rehype-sanitize";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/// Renders untrusted Markdown from GitHub.
///
/// Bodies and comments are written by other people, and this app holds a
/// token in memory, so the rendering is deliberately constrained:
///
/// - `rehype-sanitize` strips scripts, event handlers and iframes. A
///   maintained sanitiser, not a hand-rolled regex.
/// - Links open in the SYSTEM BROWSER via the opener plugin, never in the
///   app webview, so a link can never navigate the app itself.
/// - The token lives in Rust memory and is never exposed to the webview,
///   so rendered content has nothing to read even if it could run.
///
/// Remote images ARE loaded, which is a deliberate call: screenshots in
/// PR descriptions are most of the value, at the cost of a hostile
/// comment learning the reader's IP.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-[#e6edf3]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // `href` is optional in react-markdown's props but required
          // by ExternalLink, and an anchor with no target is not a link
          // -- render it as plain text rather than inventing a URL.
          a: ({ href, children }) =>
            href ? (
              <ExternalLink href={href} className="text-[#4493f8] hover:underline">
                {children}
              </ExternalLink>
            ) : (
              <span>{children}</span>
            ),
          code: ({ ...props }) => (
            <code {...props} className="rounded bg-[#161b22] px-1 py-0.5 font-mono text-xs" />
          ),
          pre: ({ ...props }) => (
            <pre
              {...props}
              className="my-3 overflow-x-auto rounded border border-[#30363d] bg-[#161b22] p-3 text-xs"
            />
          ),
          img: ({ ...props }) => (
            <img {...props} alt={props.alt ?? ""} className="max-w-full rounded" />
          ),
          // VERTICAL RHYTHM. `prose-headstate` on the wrapper was
          // never defined anywhere -- it appears once, on that div, with
          // no matching rule -- so every block element fell back to the
          // CSS reset, which strips margins. The blank lines in the
          // source WERE parsed; the resulting <p>s just had nothing
          // between them.
          p: ({ ...props }) => <p {...props} className="my-2" />,
          ul: ({ ...props }) => <ul {...props} className="my-2 list-disc space-y-1 pl-5" />,
          ol: ({ ...props }) => <ol {...props} className="my-2 list-decimal space-y-1 pl-5" />,
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className="my-2 border-l-2 border-[#30363d] pl-3 text-[#8b949e]"
            />
          ),
          hr: ({ ...props }) => <hr {...props} className="my-4 border-[#30363d]" />,
          // A heading needs more space ABOVE than below: it belongs to
          // the text that follows it, and equal margins make it float
          // between two sections instead of introducing one.
          h1: ({ ...props }) => <h1 {...props} className="mb-2 mt-5 text-base font-semibold" />,
          h2: ({ ...props }) => <h2 {...props} className="mb-2 mt-5 text-sm font-semibold" />,
          h3: ({ ...props }) => <h3 {...props} className="mb-1 mt-4 text-sm font-semibold" />,
          table: ({ ...props }) => (
            // `border-collapse`, or every cell's border doubles against
            // its neighbour's and the table reads as a heavy grid.
            <div className="my-3 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-xs" />
            </div>
          ),
          td: ({ ...props }) => <td {...props} className="border border-[#30363d] px-2 py-1" />,
          th: ({ ...props }) => (
            <th {...props} className="border border-[#30363d] px-2 py-1 font-semibold" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
