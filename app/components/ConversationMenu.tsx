'use client';
import type {ReactElement} from 'react';
import {ContextMenu} from '@base-ui/react/context-menu';
export function ConversationMenu({children,items}: {children:ReactElement;items:{label:string;onClick:()=>void;danger?:boolean}[]}){
  return <ContextMenu.Root><ContextMenu.Trigger render={children} aria-haspopup="menu" onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();event.currentTarget.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+12,clientY:rect.bottom-4}));}}}/><ContextMenu.Portal><ContextMenu.Positioner className="conversation-menu-positioner" sideOffset={4}><ContextMenu.Popup className="conversation-context-menu">{items.map(item=><ContextMenu.Item key={item.label} className={item.danger?'conversation-menu-danger':undefined} onClick={item.onClick}>{item.label}</ContextMenu.Item>)}</ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal></ContextMenu.Root>;
}
