import {lstat,mkdir,realpath} from 'node:fs/promises';
import {isAbsolute,resolve,sep} from 'node:path';
import {env} from './env';

export function taskWorkspaceName(value:unknown):string|undefined {
  if(value===undefined || value===null || value==='')return undefined;
  if(typeof value!=='string')throw new Error('Choose a relative working directory.');
  const name=value.trim().normalize('NFC');
  if(!name)return undefined;
  if(name.length>500 || isAbsolute(name) || name.includes('\0') || /[\\\r\n,:]/.test(name) || name.split('/').some(part=>!part || part==='.' || part==='..'))throw new Error('Choose a relative directory inside the configured workspace root, such as team/project.');
  return name;
}

export async function resolveTaskWorkspace(task:string|{workspaceDirectory?:string|null}):Promise<string|undefined> {
  const value=typeof task==='string'?(await env.DB.prepare('SELECT workspace_directory FROM tasks WHERE id=?').bind(task).first<{workspace_directory:string|null}>())?.workspace_directory:task.workspaceDirectory;
  const name=taskWorkspaceName(value);
  if(!name)return undefined;
  const data=resolve(process.env.SHOAL_DATA_DIR || '.shoal');
  const configured=resolve(process.env.SHOAL_WORKSPACE_ROOT || resolve(data,'workspaces'));
  await mkdir(configured,{recursive:true,mode:0o700});
  const root=await realpath(configured),dataRoot=await realpath(data);
  if((await lstat(configured)).isSymbolicLink() || root===dataRoot || dataRoot.startsWith(root+sep) || ['files','repositories','sandboxes','sources'].some(part=>root===resolve(dataRoot,part) || root.startsWith(resolve(dataRoot,part)+sep)))throw new Error('Configure a workspace root separate from Shoal storage and repository metadata.');
  let directory=root;
  for(const part of name.split('/')){
    directory=resolve(directory,part);
    if(!directory.startsWith(root+sep))throw new Error('Working directory is outside the workspace root.');
    const stat=await lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat && (stat.isSymbolicLink() || !stat.isDirectory()))throw new Error('Working directories must be real directories without symlink components.');
  }
  return directory;
}
