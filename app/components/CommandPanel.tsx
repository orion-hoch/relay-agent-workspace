"use client";
import {commands} from '@/lib/commands';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
export type CommandRequest={id:number;kind:'help';args:string};
export function CommandPanel({request,onClose}:{request:CommandRequest|null;onClose:()=>void}) {
  return <Dialog open={!!request} onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="command-dialog"><DialogHeader><DialogTitle>Commands</DialogTitle><DialogDescription className="sr-only">Workspace commands</DialogDescription></DialogHeader>
    <div className="command-reference">{commands.map(command=><div key={command.command}><code>{command.usage}</code><p>{command.description}</p></div>)}</div>
  </DialogContent></Dialog>;
}
