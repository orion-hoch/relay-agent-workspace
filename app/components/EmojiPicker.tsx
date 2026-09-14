'use client';

import { useRef, useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Smile, X } from 'lucide-react';
import emojiGroups from '@/lib/emoji-data.json';

type Props = {
  label: string;
  onSelect: (emoji: string) => void;
  focusAfterSelect?: RefObject<HTMLElement | null>;
};

export function EmojiPicker({ label, onSelect, focusAfterSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(emojiGroups[0].name);
  const selected = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const words = query.trim().toLowerCase().replaceAll('_', ' ').split(/\s+/).filter(Boolean);
  const groups = words.length ? emojiGroups : emojiGroups.filter(group => group.name === category);
  const emojis = groups.flatMap(group => group.emojis).filter(([emoji, name]) =>
    words.every(word => `${name} ${emoji}`.toLowerCase().includes(word)),
  );

  return <Popover.Root open={open} onOpenChange={value => {
    setOpen(value);
    if (value) { selected.current = false; setQuery(''); }
  }}>
    <Popover.Trigger className="icon-btn" aria-label={label} title={label}><Smile size={16} /></Popover.Trigger>
    {open && <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={8} className="emoji-positioner">
      <Popover.Popup className="emoji-picker" initialFocus={search} finalFocus={() => selected.current && focusAfterSelect ? focusAfterSelect.current : true}>
        <div className="emoji-picker-heading"><Popover.Title>{label === 'Add reaction' ? 'React with emoji' : 'Emoji'}</Popover.Title><Popover.Close className="icon-btn" aria-label="Close emoji picker"><X size={16} /></Popover.Close></div>
        <input ref={search} className="input" type="search" aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={event => setQuery(event.target.value)} />
        <select className="select" aria-label="Emoji category" value={words.length ? '' : category} onChange={event => { setCategory(event.target.value); setQuery(''); }}>
          {words.length > 0 && <option value="">Search results</option>}
          {emojiGroups.map(group => <option key={group.name}>{group.name}</option>)}
        </select>
        <div className="emoji-grid" key={words.length ? query : category}>
          {emojis.map(([emoji, name]) => <button type="button" key={emoji} aria-label={name} title={name} onClick={() => {
            selected.current = true;
            setOpen(false);
            onSelect(emoji);
          }}>{emoji}</button>)}
          {!emojis.length && <p>No emoji found.</p>}
        </div>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>}
  </Popover.Root>;
}
