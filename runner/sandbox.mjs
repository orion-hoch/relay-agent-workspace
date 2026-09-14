import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

export const commandTool = {type:'function',function:{name:'run_command',description:'Read, search, create and edit project files; run Git, Node.js/npm, Python, shell commands, builds and tests in your persistent Linux workspace. Only the granted directory is writable, mounted at /workspace. Use cwd for a subdirectory. Commands default to 300 seconds; request up to 1800 for builds. Network is available only when granted in the task context. Host files, credentials, Docker and GPUs are not exposed.',parameters:{type:'object',properties:{command:{type:'string'},cwd:{type:'string',description:'Directory relative to /workspace (default .).'},timeout:{type:'integer',minimum:1,maximum:1800,description:'Command timeout in seconds (default 300).'}},required:['command'],additionalProperties:false}}};

export async function runCommand(scope, input, signal, workspace = {}) {
  if (!/^[a-f0-9]{64}$/.test(scope || '')) throw new Error('No workspace was granted to this run.');
  if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 30000 || input.command.includes('\0') || Object.keys(input).some(key => !['command','cwd','timeout'].includes(key))) throw new Error('run_command requires a command of 1–30,000 characters.');
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 1000 || input.cwd.includes('\0'))) throw new Error('cwd must be a directory inside /workspace.');
  const timeout = input.timeout ?? 300;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800) throw new Error('timeout must be 1–1800 seconds.');
  signal?.throwIfAborted();
  let directory;
  if (workspace.directory) {
    directory = await realpath(workspace.directory).catch(error => {
      if (error.code === 'ENOENT') throw new Error('The assigned directory is unavailable on this runner. Mount the shared workspace at the same absolute path.');
      throw error;
    });
    if (!(await stat(directory)).isDirectory()) throw new Error('The granted workspace directory is unavailable.');
  } else {
    const root = resolve(process.env.SHOAL_DATA_DIR || '.shoal', 'sandboxes');
    await mkdir(root, {recursive:true, mode:0o700});
    directory = resolve(root, scope);
    await mkdir(directory, {recursive:true, mode:0o700});
    directory = await realpath(directory);
    if (!directory.startsWith((await realpath(root)) + sep)) throw new Error('Invalid workspace directory.');
  }
  const requested = input.cwd || '.';
  const virtual = posix.resolve('/workspace', requested);
  if (virtual !== '/workspace' && !virtual.startsWith('/workspace/')) throw new Error('cwd must stay inside /workspace.');
  const cwd = await realpath(resolve(directory, posix.relative('/workspace', virtual)));
  if (cwd !== directory && !cwd.startsWith(directory + sep)) throw new Error('cwd must stay inside the granted workspace.');
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be an existing directory.');
  const docker = process.env.SHOAL_DOCKER || 'docker';
  const image = process.env.SHOAL_SANDBOX_IMAGE || 'shoal-workspace:local';
  const name = 'shoal-workspace-' + randomUUID();
  const args = ['run','--rm','--pull=never','--name',name,'--network='+(workspace.network === true ? 'bridge' : 'none'),
    '--cpus',process.env.SHOAL_SANDBOX_CPUS || '2','--memory',process.env.SHOAL_SANDBOX_MEMORY || '2g',
    '--pids-limit=512','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=512m','--user',`${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    '--mount',`type=bind,source=${directory},target=/workspace`,
    '--workdir',posix.join('/workspace',relative(directory,cwd).split(sep).join('/')),
    '--env','HOME=/workspace','--env','PYTHONDONTWRITEBYTECODE=1','--env','GIT_TERMINAL_PROMPT=0',
    '--env','NPM_CONFIG_CACHE=/tmp/npm-cache','--env','PIP_CACHE_DIR=/tmp/pip-cache','--env','XDG_CACHE_HOME=/tmp/cache',
    '--env','GIT_CONFIG_NOSYSTEM=1','--env','GIT_CONFIG_GLOBAL=/dev/null'];
  if (workspace.gitDirectory) {
    const gitDirectory = await realpath(workspace.gitDirectory);
    args.push('--mount',`type=bind,source=${gitDirectory},target=/repository,readonly`,
      '--env','GIT_DIR=/repository','--env','GIT_WORK_TREE=/workspace','--env','GIT_OPTIONAL_LOCKS=0',
      '--env','GIT_CONFIG_COUNT=2','--env','GIT_CONFIG_KEY_0=safe.directory','--env','GIT_CONFIG_VALUE_0=/workspace',
      '--env','GIT_CONFIG_KEY_1=core.hooksPath','--env','GIT_CONFIG_VALUE_1=/dev/null');
  }
  args.push(image,'/bin/sh','-c',input.command);
  let first = '', last = '', size = 0, reason = '';
  const child = spawn(docker,args,{stdio:['ignore','pipe','pipe']});
  // Docker forwards SIGTERM to the shell, which may wait for a child command.
  // End the CLI immediately so finally removes the container and its whole process tree.
  const stop = () => child.kill('SIGKILL');
  const aborted = () => { reason = 'Command cancelled.'; stop(); };
  signal?.addEventListener('abort',aborted,{once:true});
  if (signal?.aborted) aborted();
  const timer = setTimeout(() => { reason = `Command exceeded ${timeout} seconds.`; stop(); },timeout*1000);
  for (const stream of [child.stdout,child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data',chunk => { size += Buffer.byteLength(chunk); first = (first+chunk).slice(0,16384); last = (last+chunk).slice(-16384); });
  }
  try {
    const exitCode = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    if (exitCode === 125) throw new Error(`Workspace unavailable. Start Docker and build its image on the runner host: docker build -f runner/Dockerfile.sandbox -t ${image} .`);
    const truncated = size > 16384;
    const output = truncated ? first+'\n… output truncated; final output follows …\n'+last : first;
    return {exitCode,output,...(truncated ? {truncated:true} : {}),...(reason ? {error:reason} : {})};
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Docker is unavailable on the runner host. Install/start Docker and build runner/Dockerfile.sandbox.');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort',aborted);
    // Killing the CLI alone can leave its container alive; always remove the named container.
    await new Promise(resolve => { const cleanup = spawn(docker,['rm','--force',name],{stdio:'ignore',timeout:10000}); cleanup.once('error',resolve); cleanup.once('close',resolve); });
  }
}
