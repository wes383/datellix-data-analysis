"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="text-2xl font-bold tracking-tight text-foreground mt-5 mb-2">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-xl font-bold tracking-tight text-foreground mt-4 mb-2">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-lg font-semibold tracking-tight text-foreground mt-3 mb-1.5">
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4 className="text-base font-semibold text-foreground mt-3 mb-1">
            {children}
          </h4>
        ),
        p: ({ children }) => (
          <p className="text-[15px] leading-relaxed text-foreground my-2 first:mt-0 last:mb-0">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-6 space-y-1.5 my-3 text-[15px] leading-relaxed text-foreground">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-6 space-y-1.5 my-3 text-[15px] leading-relaxed text-foreground">
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="text-[15px] leading-relaxed text-foreground">
            {children}
          </li>
        ),
        code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
          const isBlock = /language-(\w+)/.test(className ?? "");
          if (!isBlock) {
            // Inline code: no language-* class
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground border border-border/40"
                {...props}
              >
                {children}
              </code>
            );
          }
          // Block code: handled by the pre wrapper below
          return (
            <code className="font-mono text-sm leading-relaxed text-foreground whitespace-pre">
              {children}
            </code>
          );
        },
        pre: ({ children }) => {
          return (
            <pre className="overflow-x-auto rounded-lg bg-muted/60 p-4 my-3 border border-border">
              {children}
            </pre>
          );
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-primary/30 pl-4 my-3 text-muted-foreground italic">
            {children}
          </blockquote>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic text-foreground">{children}</em>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
          >
            {children}
          </a>
        ),
        hr: () => <hr className="my-4 border-border" />,
        table: ({ children }) => (
          <div className="overflow-x-auto my-4 rounded-lg border border-border">
            <table className="w-full text-sm text-foreground">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-muted/50 border-b border-border">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="px-4 py-2.5 text-left font-semibold text-foreground text-xs uppercase tracking-wider">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-4 py-2.5">
            {children}
          </td>
        ),
        tr: ({ children }) => (
          <tr className="border-b border-border/50 last:border-b-0 hover:bg-muted/30 transition-colors">{children}</tr>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
