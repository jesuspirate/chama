import { parseListingBody } from '../../listings/body.js';
export function ListingBody({ body }: { body: string }) {
  return <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
    {parseListingBody(body).map((block, i) => <div key={i} style={{ minHeight: '1em' }}>
      {block.type === 'item' && '• '}
      {block.children.map((node, j) => node.type === 'link'
        ? <a key={j} href={node.href} target="_blank" rel="noopener noreferrer nofollow">{node.text} ({node.href})</a>
        : node.type === 'strong' ? <strong key={j}>{node.text}</strong>
        : node.type === 'em' ? <em key={j}>{node.text}</em> : <span key={j}>{node.text}</span>)}
    </div>)}
  </div>;
}
