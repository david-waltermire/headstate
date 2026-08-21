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
/// - Links open in the SYSTEM BROWSER via `target="_blank"`, never in the
///   app webview, so a link can never navigate the app itself.
/// - The token lives in Rust memory and is never exposed to the webview,
///   so rendered content has nothing to read even if it could run.
///
/// Remote images ARE loaded, which is a deliberate call: screenshots in
/// PR descriptions are most of the value, at the cost of a hostile
/// comment learning the reader's IP.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-headstate text-sm leading-relaxed text-[#e6edf3]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[#4493f8] hover:underline"
            />
          ),
          code: ({ ...props }) => (
            <code {...props} className="rounded bg-[#161b22] px-1 py-0.5 font-mono text-xs" />
          ),
          pre: ({ ...props }) => (
            <pre
              {...props}
              className="overflow-x-auto rounded border border-[#30363d] bg-[#161b22] p-3 text-xs"
            />
          ),
          img: ({ ...props }) => (
            <img {...props} alt={props.alt ?? ""} className="max-w-full rounded" />
          ),
          ul: ({ ...props }) => <ul {...props} className="list-disc pl-5" />,
          ol: ({ ...props }) => <ol {...props} className="list-decimal pl-5" />,
          h1: ({ ...props }) => <h1 {...props} className="mt-3 text-base font-semibold" />,
          h2: ({ ...props }) => <h2 {...props} className="mt-3 text-sm font-semibold" />,
          h3: ({ ...props }) => <h3 {...props} className="mt-2 text-sm font-semibold" />,
          table: ({ ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} className="text-xs" />
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
