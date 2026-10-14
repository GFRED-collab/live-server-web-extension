const assert=require('node:assert/strict');
const {loadTs}=require('./test-load-ts.cjs');
const {decodeServiceAttachment}=loadTs('lib/service-attachment.ts');
const content=Buffer.from('%PDF-1.7\nfixture\n%%EOF').toString('base64');
assert.equal(decodeServiceAttachment({filename:'test.pdf',content}).contentType,'application/pdf');
for(const filename of ['test.exe','../test.pdf','test😀.pdf','test.jpg'])assert.throws(()=>decodeServiceAttachment({filename,content}));
assert.throws(()=>decodeServiceAttachment({filename:'test.pdf',content:'bad!'}));
assert.throws(()=>decodeServiceAttachment({filename:'test.pdf',content:Buffer.alloc(5242881).toString('base64')}));
const visit='11111111-1111-1111-1111-111111111111',device='22222222-2222-2222-2222-222222222222',file='33333333-3333-3333-3333-333333333333';
let status='draft',allowed=true,count=0,queries=[],audit=0;
const db={release(){},async query(sql,params){queries.push({sql,params});if(sql.startsWith('SELECT sv.status'))return{rows:allowed?[{status}]:[],rowCount:allowed?1:0};if(sql.includes('count(*)'))return{rows:[{count,size:0}]};if(sql.startsWith('INSERT'))return{rows:[{id:file}],rowCount:1};if(sql.startsWith('UPDATE'))return{rows:[{filename:'test.pdf'}],rowCount:1};if(sql.startsWith('SELECT filename'))return{rows:[{filename:'test.pdf',content_type:'application/pdf',content:Buffer.from('pdf')}],rowCount:1};return{rows:[],rowCount:0};}};
const api=loadTs('app/api/service-visits/[id]/attachments/route.ts',name=>{
 if(name.endsWith('/auth'))return{requireUser:async()=>({user:{id:file,role:'engineer'}})};
 if(name.endsWith('/db'))return{getDb:()=>({connect:async()=>db})};
 if(name.endsWith('/audit'))return{writeAudit:async()=>{audit++;}};
});
const context={params:Promise.resolve({id:visit})};
const request=method=>new Request('https://reports.example/api/service-visits/'+visit+'/attachments',{method,headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:device,fileId:file,filename:'test.pdf',content})});
(async()=>{
 assert.equal((await api.POST(request('POST'),context)).status,201);assert.equal(audit,1);assert.ok(queries.some(q=>q.sql.includes('FOR UPDATE OF sv')));
 status='finalized';queries=[];assert.equal((await api.POST(request('POST'),context)).status,400);assert.equal((await api.DELETE(request('DELETE'),context)).status,400);assert.ok(!queries.some(q=>q.sql.startsWith('INSERT')||q.sql.startsWith('UPDATE')));
 status='draft';allowed=false;assert.equal((await api.POST(request('POST'),context)).status,404);
 allowed=true;count=20;assert.equal((await api.POST(request('POST'),context)).status,400);
 count=0;assert.equal((await api.DELETE(request('DELETE'),context)).status,200);
 const response=await api.GET(new Request('https://reports.example/api?deviceId='+device+'&file='+file),context);
 assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.ok(queries.some(q=>q.sql.includes('WHERE id=$1 AND service_visit_id=$2 AND device_id=$3')));
 console.log('PASS attachment validation, access denial, visit locking, finalized restrictions, quota, removal and download headers (database simulated).');
})().catch(e=>{console.error(e);process.exitCode=1;});
