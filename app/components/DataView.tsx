'use client';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Database, Download, FileText, Folder, Search, Settings, Trash2, Upload, X } from 'lucide-react';
import { buzz, call, useBuzz, apply } from '@/lib/buzz/store';
import { type DocumentRecord } from '@/lib/buzz/types';
import { isAdmin } from '@/lib/team-types';
import { DEFAULT_LAYERS } from '@/lib/privacy-layers';
import { bytes } from '@/lib/format';
import { AgentActivity } from './AgentActivity';
import { DataConnections } from './DataConnections';
import { GoogleDriveSource } from './GoogleDriveSource';
import { PrivacyLayers } from './PrivacyLayers';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function openFileUpload(room:string,folder=false) {window.dispatchEvent(new CustomEvent('shoal:upload-files',{detail:{room,folder}}));}
export function openDataFile(id:string) {window.dispatchEvent(new CustomEvent('shoal:open-file',{detail:id}));}
export function openGoogleDrive(search = '') { window.dispatchEvent(new CustomEvent('shoal:google-drive', {detail:search})); }
const textFile = (file: DocumentRecord) => file.type.startsWith('text/') || /\.(md|txt|csv|json|yaml|yml|log|xml|html|js|ts|py|css|sql)$/i.test(file.name);
const fileStatus = (file: DocumentRecord) => file.status === 'ready' ? 'Ready' : file.status === 'stored' ? 'Stored only' : file.status === 'failed' ? 'Indexing failed' : file.status === 'stale' ? 'Needs reindex' : 'Indexing';
export function DataView({onNotify,room}: {onNotify?: (message:string)=>void;room?:string}) {
  const {documents,privacyLayers=DEFAULT_LAYERS,user,members,channelDetails=[]} = useBuzz();
  const canUpload = !!user && user.role !== 'viewer';
  const canEdit = (file:DocumentRecord) => !!user && (isAdmin(user) || file.owner === user.id);
  const uploadRoom=useRef(room),[uploadTarget,setUploadTarget]=useState(room);
  function pick(folder=false){uploadRoom.current=room;setUploadTarget(room);(folder?folderInput:fileInput).current?.click();}
  const [search,setSearch] = useState(''), [filter,setFilter] = useState('');
  const [files,setFiles] = useState<File[]>([]), [level,setLevel] = useState('Internal');
  const [uploading,setUploading] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('');
  const sourceTitle=useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false), fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const [dragging,setDragging] = useState(false), [selectedId,setSelectedId] = useState<string|null>(null), [busy,setBusy] = useState(false);
  const [preview,setPreview] = useState('');
  const [policyOpen,setPolicyOpen] = useState(false), [sourcesOpen,setSourcesOpen] = useState(false), [sourceType,setSourceType] = useState('database'), [driveSearch,setDriveSearch] = useState('');
  const selected = documents.find(file=>file.id===selectedId);
  const visible = useMemo(()=>documents.filter(file=>(!room || file.sourceRoom===room) && (!filter || file.level===filter) && `${file.name} ${file.relativePath || ''}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),[documents,filter,search,room]);
  const notify = (text:string) => {setMessage(text);onNotify?.(text);};
  useEffect(()=>{folderInput.current?.setAttribute('webkitdirectory','');},[]);
  useEffect(()=>{
    if(room)return;
    const uploadFiles=(event:Event)=>{const detail=(event as CustomEvent<{room:string;folder:boolean}>).detail;uploadRoom.current=detail.room;setUploadTarget(detail.room);(detail.folder?folderInput:fileInput).current?.click();};
    window.addEventListener('shoal:upload-files',uploadFiles);
    const open = (event:Event) => {setDriveSearch(String((event as CustomEvent).detail || '').slice(0,200));setSourceType('drive');setSourcesOpen(true);};
    const openFile=(event:Event)=>{setSelectedId(String((event as CustomEvent).detail));setPreview('');setError('');};
    window.addEventListener('shoal:google-drive',open);window.addEventListener('shoal:open-file',openFile);return ()=>{window.removeEventListener('shoal:upload-files',uploadFiles);window.removeEventListener('shoal:google-drive',open);window.removeEventListener('shoal:open-file',openFile);};
  },[room]);
  useEffect(()=>{
    if (!selected || !textFile(selected)) return;
    const controller = new AbortController();
    fetch(buzz.documentUrl(selected.id),{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('Preview unavailable.');return response.text();}).then(text=>setPreview(text.slice(0,64000))).catch(error=>{if(!controller.signal.aborted)setPreview(error.message);});
    return ()=>controller.abort();
  },[selected]);
  function receive(incoming:FileList|File[]|null) {
    if (!incoming?.length || busyRef.current || !canUpload) return;
    setFiles(Array.from(incoming));if(!files.length)setLevel(channelDetails.find(channel=>channel.name===uploadRoom.current)?.level || filter || 'Internal');setError('');
  }
  async function upload() {
    if (!files.length || busyRef.current) return;
    busyRef.current=true;setUploading(true);setError('');
    const failed:File[]=[],errors:string[]=[];let count=0;
    try {
      for(const file of files) {
        try {if(file.size>25*1024*1024)throw new Error('Files must be 25 MB or smaller.');await buzz.importDocument(file,{level,room:uploadRoom.current});count++;}
        catch(error){failed.push(file);errors.push(`${file.name}: ${error instanceof Error ? error.message : 'Upload failed.'}`);}
      }
      setFiles(failed);setError(errors.join('\n'));if(count)notify(`${count===1 ? 'File' : `${count} files`} uploaded.`);
    }finally{busyRef.current=false;setUploading(false);}
  }
  async function patch(file:DocumentRecord,changes:Partial<DocumentRecord>) {
    setBusy(true);setError('');
    try {const {document}=await call<{document:DocumentRecord}>('/api/documents',{method:'PATCH',body:JSON.stringify({id:file.id,...changes})});apply([{seq:0,ts:document.updatedAt,type:'document.updated',payload:{document}}]);}
    catch(error){setError(error instanceof Error ? error.message : 'Could not update file.');}
    finally{setBusy(false);}
  }
  async function remove(file:DocumentRecord) {
    setBusy(true);setError('');
    try{await buzz.deleteDocument(file.id);setSelectedId(null);notify('File deleted.');}
    catch(error){setError(error instanceof Error ? error.message : 'Could not delete file.');}
    finally{setBusy(false);}
  }
  function drop(event:DragEvent) {event.preventDefault();setDragging(false);uploadRoom.current=room;setUploadTarget(room);receive(event.dataTransfer.files);}
  return <div className={`page files-page ${dragging ? 'files-dragging' : ''}`} onDragOver={event=>{if(canUpload && event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}} onDrop={drop}>
    <header className="files-heading"><h1>{room?'Files':'Data'}</h1><div className="connection-actions">
      {canUpload && <>{!room&&<button className="btn btn-secondary" onClick={()=>setSourcesOpen(true)}><Database size={16}/>Add source</button>}<button className="btn btn-secondary" disabled={uploading} onClick={()=>pick(true)}><Folder size={16}/>Upload folder</button><button className="btn btn-primary" disabled={uploading} onClick={()=>pick()}><Upload size={16}/>Upload files</button></>}
    </div></header>
    {!room && user && isAdmin(user) && <AgentActivity />}
    <input ref={fileInput} type="file" multiple hidden aria-label="Choose files" onChange={event=>{receive(event.target.files);event.target.value='';}}/>
    <input ref={folderInput} type="file" multiple hidden aria-label="Choose folder" onChange={event=>{receive(event.target.files);event.target.value='';}}/>
    <div className="files-toolbar"><label className="files-search"><Search size={16}/><input type="search" aria-label="Search files" placeholder="Search files" value={search} onChange={event=>setSearch(event.target.value)}/></label><select className="select" aria-label="Filter classification" value={filter} onChange={event=>setFilter(event.target.value)}><option value="">All classifications</option>{privacyLayers.map(layer=><option key={layer.name}>{layer.name}</option>)}</select><button className="icon-btn classification-settings" title="Manage classifications" aria-label="Manage classifications" onClick={()=>setPolicyOpen(true)}><Settings size={18}/></button></div>
    <div className="files-table-wrap"><table className="files-table"><thead><tr><th scope="col">Name</th><th scope="col">Classification</th><th scope="col">Sharing</th><th scope="col">Status</th><th scope="col">Size</th></tr></thead><tbody>{visible.map(file=><tr key={file.id}>
      <td><button className="file-open" onClick={()=>{setSelectedId(file.id);setPreview('');setError('');}}><FileText size={20}/><span>{file.name}{file.relativePath&&<small>{file.relativePath}</small>}</span></button></td><td>{file.level}</td><td>{file.readers?.includes('*') ? 'Workspace' : file.readers?.length ? 'Selected people' : 'Private'}</td><td>{fileStatus(file)}</td><td>{bytes(file.size)}</td>
    </tr>)}</tbody></table></div>
    {!visible.length && <div className="files-empty"><FileText size={28}/><p>{documents.length ? 'No matching files.' : 'No files yet.'}</p>{canUpload && <button className="btn btn-primary" onClick={()=>pick()}>Upload files</button>}</div>}
    {dragging && <div className="files-drop">Drop files to upload</div>}
    {message && <output className="files-message">{message}</output>}
    <Dialog open={files.length>0} onOpenChange={open=>{if(!open && !busyRef.current){setFiles([]);setError('');}}}><DialogContent className="file-dialog"><DialogHeader><DialogTitle>{files.length===1 ? 'Upload file' : 'Upload files'}</DialogTitle><DialogDescription className="sr-only">Choose a classification, then upload.</DialogDescription></DialogHeader>
      <form className="file-form" onSubmit={event=>{event.preventDefault();void upload();}}>
        <div className="upload-file-list">{files.map((file,index)=><div className="upload-file" key={`${file.name}-${index}`}><FileText size={20}/><span>{file.webkitRelativePath || file.name}<small>{bytes(file.size)}</small></span><button type="button" className="icon-btn" disabled={uploading} aria-label={`Remove ${file.name}`} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}><X size={16}/></button></div>)}</div>
        <label>Classification<select className="select" aria-label="Upload classification" disabled={uploading} value={level} onChange={event=>setLevel(event.target.value)}>{privacyLayers.map(layer=><option key={layer.name}>{layer.name}</option>)}</select></label>

        <small>{uploadTarget ? uploadTarget.startsWith('dm:') ? 'Shared in this direct message.' : `Shared in #${channelDetails.find(channel=>channel.name===uploadTarget)?.displayName||uploadTarget}.` : 'Private until shared.'}</small>{error && <p className="connection-error" role="alert">{error}</p>}
        <DialogFooter><button type="button" className="btn btn-secondary" disabled={uploading} onClick={()=>setFiles([])}>Cancel</button><button type="submit" className="btn btn-primary" disabled={uploading || !files.length}>{uploading ? 'Uploading' : files.length===1 ? 'Upload file' : `Upload ${files.length} files`}</button></DialogFooter>
      </form></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={open=>{if(!open && !busy)setSelectedId(null);}}><DialogContent className="file-dialog file-detail-dialog">{selected && <>
      <DialogHeader><DialogTitle>{selected.name}</DialogTitle><DialogDescription>{bytes(selected.size)} / {fileStatus(selected)}</DialogDescription></DialogHeader>
      {selected.error && !selected.error.startsWith('Keyword search only:') && <div className="file-error"><p>{selected.error}</p>{canEdit(selected) && <button className="btn btn-secondary" disabled={busy || ['extracting','indexing'].includes(selected.status)} onClick={async()=>{setBusy(true);try{await call('/api/documents/reindex',{method:'POST',body:JSON.stringify({id:selected.id})});notify('Indexing queued.');}catch(error){setError(error instanceof Error ? error.message : 'Could not reindex.');}finally{setBusy(false);}}}>Retry indexing</button>}</div>}
      <div className="file-properties"><label>Classification<select className="select" aria-label="File classification" disabled={busy || !canEdit(selected)} value={selected.level} onChange={event=>void patch(selected,{level:event.target.value})}>{privacyLayers.map(layer=><option key={layer.name}>{layer.name}</option>)}</select></label><label>Sharing<select className="select" aria-label="File sharing" disabled={busy || !canEdit(selected)} value={selected.readers?.includes('*') ? 'workspace' : selected.readers?.length ? 'people' : 'private'} onChange={event=>{if(event.target.value!=='people')void patch(selected,{readers:event.target.value==='workspace'?['*']:[]});}}><option value="private">Private</option><option value="workspace">Workspace</option>{!!selected.readers?.length && !selected.readers.includes('*') && <option value="people">Selected people</option>}</select></label></div>
      <details><summary>Share with specific people</summary><fieldset disabled={busy || !canEdit(selected)}>{members.filter(member=>member.kind==='human' && member.id!==selected.owner).map(person=><label className="team-check" key={person.id}><input type="checkbox" checked={selected.readers?.includes(person.id) || false} onChange={event=>void patch(selected,{readers:event.target.checked ? [...(selected.readers || []).filter(id=>id!=='*'),person.id] : (selected.readers || []).filter(id=>id!==person.id)})}/>{person.name}</label>)}</fieldset></details>
      {!selected.agents.includes('*') && <label>Agent access<select className="select" aria-label="File agent access" disabled={busy || !canEdit(selected)} value="restricted" onChange={()=>void patch(selected,{agents:['*']})}><option value="restricted">{selected.agents.length ? 'Only ' + selected.agents.map(id=>members.find(m=>m.id===id)?.name || 'Deleted agent').join(', ') : 'No agents'}</option><option value="classification">All agents allowed by classification</option></select></label>}
      {textFile(selected) ? <pre className="file-preview">{preview || 'Loading preview'}</pre> : selected.type==='application/pdf' ? <iframe className="file-pdf" title={selected.name} src={buzz.documentUrl(selected.id)+'&preview=1'}/> : /^image\/(png|jpeg|webp|gif|avif)$/.test(selected.type) ? <Image unoptimized width={700} height={480} className="file-image" src={buzz.documentUrl(selected.id)+'&preview=1'} alt={selected.name}/> : null}
      {error && <p className="connection-error" role="alert">{error}</p>}<DialogFooter>{canEdit(selected) && <button className="btn file-delete" disabled={busy} onClick={()=>void remove(selected)}><Trash2 size={16}/>Delete</button>}<a className="btn btn-primary" href={buzz.documentUrl(selected.id)} download={selected.name}><Download size={16}/>Download</a></DialogFooter>
    </>}</DialogContent></Dialog>
    <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}><DialogContent initialFocus={sourceTitle} className="connection-dialog integrations-dialog"><DialogHeader><DialogTitle ref={sourceTitle} tabIndex={-1}>Data sources</DialogTitle><DialogDescription className="sr-only">Add a database or Google Drive file.</DialogDescription></DialogHeader>{user && isAdmin(user) && <label>Source<select className="select" aria-label="Data source" value={sourceType} onChange={event=>setSourceType(event.target.value)}><option value="database">Database</option><option value="drive">Google Drive</option></select></label>}{sourcesOpen && (sourceType==='drive' || !user || !isAdmin(user) ? <GoogleDriveSource key={driveSearch} initialSearch={driveSearch}/> : <DataConnections/>)}</DialogContent></Dialog>
    <Dialog open={policyOpen} onOpenChange={setPolicyOpen}><DialogContent className="file-dialog"><DialogHeader><DialogTitle>Classifications</DialogTitle><DialogDescription className="sr-only">Agent clearance and local processing rules.</DialogDescription></DialogHeader><PrivacyLayers/></DialogContent></Dialog>
  </div>;
}
