import type {RunRecord} from './buzz/types';
export type AgentTask={id:string;goal:string;context:string;agentId:string;room:string;status:'open'|'done';createdAt:string;workspaceDirectory?:string;repository?:{url:string;branch:string;hasToken:boolean}|null;run:RunRecord|null};
export const taskStatus=(task:AgentTask)=>task.status==='done'?'Done':!task.run?'Ready':({queued:'Queued',preparing:'Preparing',running:'Working',awaiting:'Awaiting approval',needs_input:'Needs input',paused:'Progress saved',completed:'Ready for review',failed:'Failed',cancelled:'Stopped'}[task.run.status]);

export const taskActive=(task?:AgentTask)=>!!task?.run && ['queued','preparing','running','awaiting'].includes(task.run.status);
