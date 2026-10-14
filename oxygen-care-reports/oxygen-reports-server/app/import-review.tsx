'use client';
import {useEffect,useRef,useState} from 'react';
import type {ImportWarning} from '../lib/import-duplicates';
import './report-tools.css';
export default function ImportReview({accepted,warnings,confirm,close}:{accepted:number;warnings:ImportWarning[];confirm:()=>Promise<void>;close:()=>void}){
 const ref=useRef<HTMLDialogElement>(null),lock=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{ref.current?.showModal();},[]);
 async function submit(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await confirm();}catch(e){setError(e instanceof Error?e.message:'Import failed.');}finally{lock.current=false;setBusy(false);}}
 return <dialog ref={ref} className="report-dialog csv-preview" onCancel={event=>{if(busy)event.preventDefault();else close();}} aria-labelledby="import-review-title"><h2 id="import-review-title">Review report import</h2><p>{accepted} rows to import · {warnings.length} rows will be skipped.</p><p>Duplicates are skipped within this file and the selected service visit. Later visits are allowed. Existing records will not be overwritten.</p>{warnings.length>0&&<div className="csv-scroll"><table><thead><tr><th>Row</th><th>Serial / asset</th><th>Reason for skipping</th></tr></thead><tbody>{warnings.map((w,i)=><tr key={i}><td>{w.row}</td><td>{w.identifier}</td><td>{w.reason}</td></tr>)}</tbody></table></div>}{!accepted&&<p>No new identifiable devices remain to import.</p>}{error&&<p role="alert">{error}</p>}<div className="csv-actions"><button type="button" disabled={busy||!accepted} onClick={()=>void submit()}>{busy?'Importing…':'Import new rows only'}</button><button type="button" disabled={busy} onClick={close}>{accepted?'Cancel':'Close'}</button></div></dialog>;
}
