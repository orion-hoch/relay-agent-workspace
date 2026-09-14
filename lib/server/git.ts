import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat,readdir,readFile,readlink,realpath,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {env} from './env';
import {assertCloudAccess,assertEndpoint} from './network';
import {seal,unseal} from '../buzz/secrets';
import {resolveTaskWorkspace} from './task-workspace';
export type GitTask={id:string;owner:string;agentId:string;room:string;workspaceDirectory?:string};
export type TaskRepository={url:string;branch:string;hasToken:boolean};
const exec=promisify(execFile);
export async function repositoryPaths(task:GitTask){
  if(!/^task_[a-f0-9]{20}$/.test(task.id))throw new Error('Invalid task.');
  const scope=createHash('sha256').update(JSON.stringify([task.owner,task.agentId,task.room])).digest('hex');
  const root=resolve(process.env.SHOAL_DATA_DIR || '.shoal');
  return {git:resolve(root,'repositories',task.id),work:await resolveTaskWorkspace(task.workspaceDirectory?task:task.id) || resolve(root,'sandboxes',scope)};
}
export async function allowedURL(value:string){
  let url:URL;try{url=new URL(value);}catch{throw new Error('Enter an HTTPS Git repository URL.');}
  if(url.protocol!=='https:' || url.username || url.password || url.hash || url.search || value.length>1000)throw new Error('Use an HTTPS repository URL without credentials or query parameters.');
  if(['github.com','gitlab.com','bitbucket.org'].includes(url.hostname))await assertCloudAccess(env);else await assertEndpoint(env,url.href);
  if(['github.com','gitlab.com','bitbucket.org'].includes(url.hostname))url.pathname=url.pathname.replace(/\/$/,'').replace(/(?:\.git)?$/,'.git');
  return url.href;
}
async function git(args:string[],options:{task?:GitTask;url?:string;token?:string;signal?:AbortSignal}={}){
  const path=options.task?await repositoryPaths(options.task):null;
  const childEnv:NodeJS.ProcessEnv={NODE_ENV:process.env.NODE_ENV || 'production',PATH:process.env.PATH,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'https',GIT_PAGER:'cat',GIT_LFS_SKIP_SMUDGE:'1'};
  if(options.token && options.url){childEnv.GIT_CONFIG_COUNT='1';childEnv.GIT_CONFIG_KEY_0=`http.${options.url}.extraHeader`;childEnv.GIT_CONFIG_VALUE_0='Authorization: Basic '+Buffer.from('git:'+options.token).toString('base64');}
  try{
    const result=await exec('git',['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','http.followRedirects=false',...(path?['--git-dir='+path.git,'--work-tree='+path.work]:[]),...args],{cwd:path?.work,env:childEnv,signal:options.signal,timeout:120000,maxBuffer:1024*1024});
    return result.stdout;
  }catch(error){
    let message=String((error as {stderr?:string}).stderr || (error as Error).message).slice(0,1500);
    if(options.token)message=message.split(options.token).join('[redacted]').split(Buffer.from('git:'+options.token).toString('base64')).join('[redacted]');
    throw new Error(message || 'Git command failed.');
  }
}
export async function prepareRepository(task:GitTask,urlInput:string,tokenInput='',baseBranch='',signal?:AbortSignal){
  signal?.throwIfAborted();
  const url=await allowedURL(urlInput);
  if(tokenInput.length>8192 || (/[\r\n]/.test(tokenInput) || tokenInput.includes('\0')))throw new Error('Invalid repository token.');
  if(baseBranch && (!/^[\w./-]{1,180}$/.test(baseBranch) || baseBranch.startsWith('-') || baseBranch.includes('..')))throw new Error('Enter a valid base branch.');
  const paths=await repositoryPaths(task),branch='shoal/'+task.id;
  const existing=await lstat(paths.work).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(paths.work)).length))throw new Error('The task working directory must be empty to clone a repository. Existing files have been kept.');
  await mkdir(resolve(paths.git,'..'),{recursive:true,mode:0o700});await mkdir(resolve(paths.work,'..'),{recursive:true,mode:0o700});
  let createdGit=false,createdWork=false;
  try{
    await mkdir(paths.git,{mode:0o700});createdGit=true;
    if(!existing){await mkdir(paths.work,{mode:0o700});createdWork=true;}
    await git(['clone','--bare','--depth=1',...(baseBranch?['--branch',baseBranch]:[]),'--',url,paths.git],{url,token:tokenInput,signal});
    signal?.throwIfAborted();
    await git(['config','core.bare','false'],{task,signal});
    await git(['checkout','-b',branch,'HEAD'],{task,signal});
    return {repository:{url,branch,hasToken:!!tokenInput},secret:await seal(env,tokenInput)};
  }catch(error){if(createdGit)await rm(paths.git,{recursive:true,force:true});if(createdWork)await rm(paths.work,{recursive:true,force:true});throw error;}
}
export async function repositoryInfo(taskId:string){
  const row=await env.DB.prepare("SELECT config FROM connections WHERE id=? AND kind='git'").bind('git:'+taskId).first<{config:string}>();
  return row?JSON.parse(row.config) as TaskRepository:null;
}
export async function gitChanges(task:GitTask){
  const status=await git(['status','--short'],{task});
  let diff=await git(['diff','HEAD','--no-ext-diff','--no-textconv','--'],{task});
  const paths=await repositoryPaths(task);
  const files=(await git(['ls-files','--others','--exclude-standard','-z'],{task})).split('\0').filter(Boolean);
  for(const file of files.slice(0,40)){
    const path=resolve(paths.work,file),stat=await lstat(path);
    if(stat.isSymbolicLink()){diff+=`\nNew file: ${file}\nSymlink: ${await readlink(path)}\n`;continue;}
    if(!(await realpath(path)).startsWith((await realpath(paths.work))+sep))throw new Error('Repository file is outside the workspace.');
    diff+=`\nNew file: ${file}\n${stat.size>16384?'Preview omitted: file exceeds 16 KB.':await readFile(path,'utf8')}\n`;
    if(diff.length>64000)break;
  }
  return {status,diff:diff.slice(0,64000),truncated:diff.length>64000 || files.length>40,head:(await git(['rev-parse','--short','HEAD'],{task})).trim()};
}
export async function commitRepository(task:GitTask,message:string,name:string){
  if(!message.trim() || message.length>1000 || message.includes('\0'))throw new Error('Enter a commit message under 1,000 characters.');
  await git(['add','--all','--','.'],{task});
  return git(['-c','user.name='+name,'-c','user.email=shoal@localhost','-c','commit.gpgSign=false','commit','-m',message],{task});
}
export async function pushRepository(task:GitTask){
  const row=await env.DB.prepare("SELECT config,secret FROM connections WHERE id=? AND kind='git'").bind('git:'+task.id).first<{config:string;secret:string}>();
  if(!row)throw new Error('Repository not connected.');
  const repository=JSON.parse(row.config) as TaskRepository;
  const url=await allowedURL(repository.url),token=await unseal(env,row.secret);
  return git(['push',url,'HEAD:refs/heads/'+repository.branch],{task,url,token});
}
