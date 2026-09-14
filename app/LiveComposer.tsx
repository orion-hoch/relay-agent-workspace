'use client';
import * as React from 'react';
import { MemberAvatar } from '@/components/MemberAvatar';
import type { WorkspaceMember } from '@/lib/workspace-members';

type Props = {value:string;onChange:(value:string)=>void;onSend:()=>void;members:readonly WorkspaceMember[];currentUserId:string;placeholder:string};
export type ComposerHandle = HTMLTextAreaElement & { insertText: (text: string) => void };
export const LiveComposer=React.forwardRef<ComposerHandle,Props>(function LiveComposer({value,onChange,onSend,members,currentUserId,placeholder},forwardedRef){
 const field=React.useRef<HTMLTextAreaElement>(null);
 const [caret,setCaret]=React.useState(0),[active,setActive]=React.useState(0),[dismissed,setDismissed]=React.useState(false);
 const prefix=value.slice(0,caret),match=prefix.match(/(?:^|\s)@([^@\n]{0,50})$/);
 const query=match?.[1]??'';
 const options=match&&!dismissed?members.filter(m=>m.id!==currentUserId&&m.name.toLowerCase().includes(query.toLowerCase())).slice(0,8):[];
 const listId=React.useId();
 React.useEffect(()=>{document.getElementById(`${listId}-${Math.min(active, options.length-1)}`)?.scrollIntoView({block:'nearest'});},[active,listId,options.length]);
 React.useImperativeHandle(forwardedRef,()=>Object.assign(field.current!,{insertText(text:string){const start=field.current?.selectionStart??value.length,end=field.current?.selectionEnd??value.length;const nextCaret=start+text.length;onChange(value.slice(0,start)+text+value.slice(end));setCaret(nextCaret);setDismissed(false);setActive(0);requestAnimationFrame(()=>{field.current?.focus();field.current?.setSelectionRange(nextCaret,nextCaret);});}}));
 function choose(member:WorkspaceMember){const start=prefix.lastIndexOf('@');const inserted=`@${member.name} `;onChange(value.slice(0,start)+inserted+value.slice(caret));setDismissed(true);requestAnimationFrame(()=>{field.current?.focus();field.current?.setSelectionRange(start+inserted.length,start+inserted.length);setCaret(start+inserted.length)});}
 return <div className="live-composer-input">
  {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A custom keyboard mention popup requires listbox and option semantics; native select is prohibited. */}
  {options.length>0&&<div id={listId} role="listbox" aria-label="Mention a member" className="mention-picker">{options.map((member,index)=><button type="button" role="option" aria-selected={index===active} id={`${listId}-${index}`} key={member.id} className={index===active?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(member)}><MemberAvatar member={member} size={26}/><span>{member.name}</span></button>)}</div>}
  <textarea ref={field} value={value} aria-label="Message conversation" aria-autocomplete="list" aria-controls={options.length?listId:undefined} aria-activedescendant={options.length?`${listId}-${Math.min(active,options.length-1)}`:undefined} placeholder={placeholder}
   onSelect={e=>{setCaret(e.currentTarget.selectionStart)}}
   onChange={e=>{onChange(e.target.value);setCaret(e.target.selectionStart);setDismissed(false);setActive(0)}}
   onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(options.length){if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setActive(i=>(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);return}if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();choose(options[Math.min(active,options.length-1)]);return}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setDismissed(true);return}}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();onSend()}}}/>
 </div>
});
