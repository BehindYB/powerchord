import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/** Renders agent output as Markdown. Raw HTML in the source is not rendered. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown select-text">
      <ReactMarkdown
        // Agents and models write single line breaks for separate lines, as chat apps show them.
        remarkPlugins={[remarkGfm, remarkBreaks]}
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
