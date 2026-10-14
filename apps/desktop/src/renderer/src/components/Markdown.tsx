import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders agent output as Markdown. Raw HTML in the source is not rendered. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
