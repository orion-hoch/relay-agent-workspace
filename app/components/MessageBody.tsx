'use client';
import { Fragment, type ReactNode } from 'react';
import { useBuzz, buzz } from '@/lib/buzz/store';

function safeLink(value: string) {
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function MessageBody({ text, mention }: { text: string; mention: RegExp }) {
  const { documents } = useBuzz();
  const inline = (value: string): ReactNode[] => {
    const tokens = new RegExp(/\[[^\]\n]+\]\([^\s)]+\)|\[[^\]\n]+ §\d+\]|`[^`\n]+`|https?:\/\/[^\s<>]+/.source + '|' + mention.source, 'g');
    const output: ReactNode[] = []; let from = 0;
    for (const match of value.matchAll(tokens)) {
      const part = match[0], index = match.index!;
      output.push(value.slice(from, index)); from = index + part.length;
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part), citation = /^\[(.+) §(\d+)\]$/.exec(part);
      const source = citation ? documents.filter(document => document.name === citation[1]) : [];
      const href = link ? safeLink(link[2]) : /^https?:/.test(part) ? safeLink(part) : null;
      output.push(<Fragment key={index}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{link?.[1] ?? part}</a>
        : citation && source.length === 1 ? <a className="source-citation" href={buzz.documentUrl(source[0].id)} target="_blank" rel="noopener noreferrer" title={`Open ${source[0].name}, cited section ${citation[2]}`}>{part}</a>
        : part.startsWith('`') ? <code>{part.slice(1, -1)}</code>
        : part.startsWith('**') ? <strong>{part.slice(2, -2)}</strong>
        : part.startsWith('@') ? <span className="mention">{part}</span> : part}</Fragment>);
    }
    output.push(value.slice(from)); return output;
  };
  const prose = (value: string) => value.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => {
    const lines = paragraph.split('\n');
    if (lines.every(line => /^\s*[-*] /.test(line))) return <ul key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*[-*] /, ''))}</li>)}</ul>;
    if (lines.every(line => /^\s*\d+\. /.test(line))) return <ol key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\s*\d+\. /, ''))}</li>)}</ol>;
    return <p key={index}>{inline(paragraph.replace(/^#{1,6} /gm, ''))}</p>;
  });
  const blocks: ReactNode[] = []; let from = 0;
  for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g)) {
    blocks.push(<Fragment key={`text-${from}`}>{prose(text.slice(from, match.index))}</Fragment>);
    blocks.push(<div className="message-code" key={`code-${match.index}`}><div><span>{match[1].trim() || 'Code'}</span><button type="button" onClick={() => void navigator.clipboard.writeText(match[2]).then(() => window.dispatchEvent(new CustomEvent('shoal:notice', { detail: 'Code copied.' }))).catch(() => window.dispatchEvent(new CustomEvent('shoal:notice', { detail: 'Could not copy. Select and copy the code manually.' })))}>Copy code</button></div><pre><code>{match[2]}</code></pre></div>);
    from = match.index! + match[0].length;
  }
  blocks.push(<Fragment key={`text-${from}`}>{prose(text.slice(from))}</Fragment>);
  return <div className="message-content">{blocks}</div>;
}
