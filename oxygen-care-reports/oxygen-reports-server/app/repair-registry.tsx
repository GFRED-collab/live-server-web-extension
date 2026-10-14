'use client';
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import './repair-registry.css';
import { brandPrintWindow } from './print-layout';
import {csvCell} from '../lib/csv-export';

type User={id:string;displayName:string;role:string};
type Client={id:string;name:string};
type Repair={id:string;entryNumber:string;receivedDate:string;clientId:string|null;clientName:string;deviceName:string;manufacturer:string;model:string;serialNumber:string;assetNumber:string;reportedFault:string;conditionReceived:string;workCarriedOut:string;partsUsed:string;followUpWork:string;status:string;priority:string;engineerId:string|null;engineerName:string;completedDate:string|null;createdBy:string|null};
const labels:Record<string,string>={received:'Received',diagnosing:'Diagnosing',awaiting_parts:'Awaiting parts',in_progress:'In progress',follow_up:'Follow-up required',completed:'Completed',returned:'Returned to client'};
const statuses=Object.keys(labels);
async function call<T>(path:string,options?:RequestInit):Promise<T>{const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options?.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'The request could not be completed.');return data as T;}

export default function RepairRegistry({user,sidebar}:{user:User;sidebar:ReactNode}){
 const[repairs,setRepairs]=useState<Repair[]>([]),[clients,setClients]=useState<Client[]>([]),[selectedId,setSelectedId]=useState<string|null>(null),[search,setSearch]=useState(''),[statusFilter,setStatusFilter]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [clientFilter,setClientFilter]=useState('');
 const dialogRef=useRef<HTMLDialogElement>(null),editRef=useRef<HTMLFormElement>(null);
 useEffect(()=>{if(selectedId)dialogRef.current?.showModal();},[selectedId]);
 function closeEditor(){if(editRef.current?.dataset.dirty==='true'&&!window.confirm('Close without saving your changes?'))return;dialogRef.current?.close();setSelectedId(null);}
 function outputRows(){
  if(!selected)return [];
  const values={...selected,...Object.fromEntries(editRef.current?new FormData(editRef.current).entries():[])};
  return [['Entry number',values.entryNumber],['Received date',values.receivedDate],['Client',values.clientName],['Device / machine',values.deviceName],['Manufacturer',values.manufacturer],['Model',values.model],['Serial number',values.serialNumber],['Asset number',values.assetNumber],['Priority',values.priority],['Status',labels[values.status]],['Engineer',values.engineerName],['Completed date',values.completedDate],['Reported fault',values.reportedFault],['Condition on receipt',values.conditionReceived],['Work carried out',values.workCarriedOut],['Parts used',values.partsUsed],['Follow-up work',values.followUpWork]].map(([label,value])=>[label,String(value||'')]);
 }
 function exportEntry(){
  const quote=(value:string)=>'"'+csvCell(value).replace(/"/g,'""')+'"';
  const url=URL.createObjectURL(new Blob(['\uFEFF'+[['Field','Value'],...outputRows()].map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=(selected?.entryNumber||'repair')+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function printEntry(){
  const popup=window.open('','_blank','width=950,height=800');
  if(!popup){setError('Please allow the print window in your browser.');return;}
  popup.opener=null;
  const doc=popup.document;
  doc.open();doc.write('<!doctype html><html><head><title>Repair entry</title></head><body></body></html>');doc.close();
  doc.title=selected?.entryNumber||'Repair entry';
  const style=doc.createElement('style');style.textContent='body{font:14px Arial;color:#183f4b;padding:32px}dl{display:grid;grid-template-columns:180px 1fr;gap:12px}dt{font-weight:bold}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}button{margin:0 12px 20px 0;padding:10px}@media print{button{display:none}}';doc.head.append(style);
  const title=doc.createElement('h1');title.textContent='Oxygen Care — Repair Registry';doc.body.append(title);
  const print=doc.createElement('button');print.textContent='Print / Save PDF';print.onclick=()=>popup.print();doc.body.append(print);
  const close=doc.createElement('button');close.textContent='Close';close.onclick=()=>popup.close();doc.body.append(close);
  const list=doc.createElement('dl');for(const [label,value]of outputRows()){const term=doc.createElement('dt'),detail=doc.createElement('dd');term.textContent=label;detail.textContent=value||'—';list.append(term,detail);}doc.body.append(list);brandPrintWindow(popup);popup.focus();
 }
 const load=async()=>{try{const[{repairs:rows},{clients:clientRows}]=await Promise.all([call<{repairs:Repair[]}>('/api/repairs'),call<{clients:Client[]}>('/api/clients')]);setRepairs(rows);setClients(clientRows);setError('');}catch(reason){setError(reason instanceof Error?reason.message:'Could not load the repair registry.')}};
 useEffect(()=>{void load()},[]);
 const selected=repairs.find((repair)=>repair.id===selectedId)||null;
 const filtered=useMemo(()=>{const term=search.trim().toLowerCase();return repairs.filter(repair=>{
  const closed=['completed','returned'].includes(repair.status);
  const statusMatches=!statusFilter||(statusFilter==='open'?!closed:statusFilter==='closed'?closed:repair.status===statusFilter);
  return statusMatches&&(!clientFilter||repair.clientName.toLowerCase().includes(clientFilter.trim().toLowerCase()))&&(!term||[repair.entryNumber,repair.clientName,repair.deviceName,repair.model,repair.serialNumber,repair.assetNumber,repair.reportedFault,repair.engineerName].some(value=>value.toLowerCase().includes(term)));
 })},[repairs,search,statusFilter,clientFilter]);
 function printList(){
  const popup=window.open('','_blank','width=1100,height=800');if(!popup){setError('Please allow the print window in your browser.');return;}
  const doc=popup.document;doc.open();doc.write('<!doctype html><html><head><title>Repair registry list</title></head><body></body></html>');doc.close();
  const heading=doc.createElement('h1');heading.textContent='Repair Registry';doc.body.append(heading);
  const summary=doc.createElement('p');summary.textContent=filtered.length+' entries · Status: '+(statusFilter||'All')+' · Client: '+(clientFilter||'All')+' · Search: '+(search||'None');doc.body.append(summary);
  const table=doc.createElement('table'),head=table.createTHead().insertRow(),body=table.createTBody();
  for(const label of ['Entry','Received','Client','Device / serial','Status','Engineer']){const th=doc.createElement('th');th.textContent=label;head.append(th);}
  for(const repair of filtered){const row=body.insertRow();for(const value of [repair.entryNumber,repair.receivedDate,repair.clientName,repair.deviceName+' / '+(repair.serialNumber||'—'),labels[repair.status],repair.engineerName])row.insertCell().textContent=value;}
  doc.body.append(table);brandPrintWindow(popup);
 }
 async function createRepair(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,values=new FormData(form),client=clients.find((item)=>item.id===values.get('clientId'));try{const created=await call<{id:string;entryNumber:string}>('/api/repairs',{method:'POST',body:JSON.stringify({...Object.fromEntries(values.entries()),clientName:client?.name||''})});form.reset();setMessage(`${created.entryNumber} added to the repair registry.`);setError('');await load();setSelectedId(created.id);}catch(reason){setError(reason instanceof Error?reason.message:'Could not create the repair entry.');setMessage('')}}
 async function updateRepair(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!selected)return;const values=new FormData(event.currentTarget);try{await call('/api/repairs',{method:'PATCH',body:JSON.stringify({id:selected.id,...Object.fromEntries(values.entries())})});if(editRef.current)editRef.current.dataset.dirty='false';setMessage(`${selected.entryNumber} updated.`);setError('');await load();}catch(reason){setError(reason instanceof Error?reason.message:'Could not update the repair entry.');setMessage('')}}
 const canEdit=Boolean(selected&&(user.role==='super_user'||selected.createdBy===user.id||selected.engineerId===user.id));
 const fields=(defaults?:Repair)=><div className="repair-form-grid">
  {!defaults&&<><label>RECEIVED DATE<input name="receivedDate" type="date" defaultValue={new Date().toISOString().slice(0,10)} required/></label><label>CLIENT<select name="clientId" defaultValue=""><option value="">No client selected</option>{clients.map((client)=><option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label>DEVICE / MACHINE<input name="deviceName" required/></label><label>MANUFACTURER<input name="manufacturer"/></label><label>MODEL<input name="model"/></label><label>SERIAL NUMBER<input name="serialNumber"/></label><label>ASSET NUMBER<input name="assetNumber"/></label></>}
  <label>PRIORITY<select name="priority" defaultValue={defaults?.priority||'normal'} disabled={Boolean(defaults&&!canEdit)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
  <label>STATUS<select name="status" defaultValue={defaults?.status||'received'} disabled={Boolean(defaults&&!canEdit)}>{statuses.map((status)=><option key={status} value={status}>{labels[status]}</option>)}</select></label>
  <label>ENGINEER<input name="engineerName" defaultValue={defaults?.engineerName||user.displayName} disabled={Boolean(defaults&&!canEdit)}/></label><input name="engineerId" type="hidden" value={defaults?.engineerId||''}/>
  <label>COMPLETED DATE<input name="completedDate" type="date" defaultValue={defaults?.completedDate||''} disabled={Boolean(defaults&&!canEdit)}/></label>
  <label className="wide">REPORTED FAULT<textarea name="reportedFault" rows={3} defaultValue={defaults?.reportedFault||''} required disabled={Boolean(defaults&&!canEdit)}/></label>
  <label className="wide">CONDITION ON RECEIPT<textarea name="conditionReceived" rows={2} defaultValue={defaults?.conditionReceived||''} disabled={Boolean(defaults&&!canEdit)}/></label>
  <label className="wide">WORK CARRIED OUT<textarea name="workCarriedOut" rows={4} defaultValue={defaults?.workCarriedOut||''} disabled={Boolean(defaults&&!canEdit)}/></label>
  <label className="wide">PARTS USED<textarea name="partsUsed" rows={2} defaultValue={defaults?.partsUsed||''} disabled={Boolean(defaults&&!canEdit)}/></label>
  <label className="wide follow-up-field">FOLLOW-UP WORK<textarea name="followUpWork" rows={3} defaultValue={defaults?.followUpWork||''} disabled={Boolean(defaults&&!canEdit)}/></label>
 </div>;
 return <main className="workspace-shell subpage-shell repair-page">{sidebar}<header className="workspace-header"><div><p className="eyebrow">EQUIPMENT REPAIRS</p><h1>Repair Registry</h1><p className="muted">Track machines from receipt through repair, follow-up and return.</p></div><button className="access-button" onClick={()=>void load()}>Refresh</button></header>{(message||error)&&<p className={error?'message error':'message success'}>{error||message}</p>}
 <section className="repair-layout"><form className="repair-form" onSubmit={createRepair}><div className="repair-section-heading"><div><p className="eyebrow">NEW ENTRY</p><h2>Machine / device intake</h2></div><span>Number assigned automatically</span></div>{fields()}<button className="primary" type="submit">Create repair entry <span>→</span></button></form>
 <section className="repair-register"><div className="repair-tools"><label>SEARCH<input value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Entry, client, serial or device"/></label><label>STATUS<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option>{statuses.map((status)=><option key={status} value={status}>{labels[status]}</option>)}</select></label><label>CLIENT SEARCH<input value={clientFilter} onChange={event=>setClientFilter(event.target.value)} placeholder="Client name"/></label><button className="access-button" type="button" onClick={printList}>Print filtered list</button></div><div className="repair-list"><div className="directory-heading"><div><p className="eyebrow">REGISTER</p><h2>Repair entries</h2></div><span>{filtered.length} entries</span></div>{filtered.map((repair)=><button type="button" className={repair.id===selectedId?'active':''} key={repair.id} onClick={()=>setSelectedId(repair.id)}><span className={`repair-priority ${repair.priority}`}>{repair.priority}</span><strong>{repair.entryNumber}</strong><span>{repair.deviceName}</span><small>{repair.clientName||'No client'} · {repair.serialNumber||'No serial number'}</small><em>{labels[repair.status]}</em></button>)}{!filtered.length&&<p className="muted">No repair entries match the filters.</p>}</div></section></section>
 {selected&&<dialog ref={dialogRef} className="repair-dialog" aria-label="Repair entry editor" onCancel={event=>{event.preventDefault();closeEditor();}}><section className="repair-detail"><div className="repair-editor-actions"><button type="button" onClick={printEntry}>Print / Save PDF</button><button type="button" onClick={exportEntry}>Export CSV</button><button type="button" onClick={closeEditor} autoFocus>Close</button></div>{(message||error)&&<p role="status" className={error?'message error':'message success'}>{error||message}</p>}<div className="directory-heading"><div><p className="eyebrow">{selected.entryNumber}</p><h2>{selected.deviceName}</h2><p className="muted">{selected.clientName||'No client'} · Serial {selected.serialNumber||'—'} · Asset {selected.assetNumber||'—'}</p></div><span>{labels[selected.status]}</span></div><form key={selected.id} ref={editRef} onChange={()=>{if(editRef.current)editRef.current.dataset.dirty='true';}} onSubmit={updateRepair}>{fields(selected)}{canEdit&&<button type="submit">Save repair update</button>}</form></section></dialog>}</main>;
}
