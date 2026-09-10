import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, treeDigest, validateEvidence } from '../lib/verification.mjs';
import { createFailureFeedback, loadFailureFeedback } from '../lib/feedback.mjs';
import { spawnSync } from 'node:child_process';
const policy={version:1,enabled:true,roles:{maintainers:[1],testOwners:[1],administrators:[1]},implementationPaths:['src/'],testPaths:['tests/'],maxFiles:10,maxBytes:100000};
const file=content=>({content:Buffer.from(content).toString('base64'),mode:'100644'});
const baseFiles={'src/add.mjs':file('export const add=(a,b)=>a-b;'),'tests/base.test.mjs':file("import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/add.mjs';test('zero',()=>assert.equal(add(0,0),0));")};
const payload=()=>({policy,baseFiles,testFiles:{...baseFiles,'tests/regression.test.mjs':file("import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/add.mjs';test('addition',()=>assert.equal(add(2,3),5));")},candidate:{changes:[{path:'src/add.mjs',content:'export const add=()=>0;'}]},authorization:{repository:'a/b',issue:1,testPr:2,testHead:'approved'}});
test('failed real candidate preserves assertion expected/actual without success evidence',async()=>{
  const p=payload();let error;
  try {await verify(p);} catch(e) {error=e;}
  assert.ok(error);const f=error.feedback;
  assert.equal(f.stage,'candidate');assert.match(f.logs.candidate,/expected: 5/);assert.match(f.logs.candidate,/actual: 0/);
  assert.equal(f.testDigest,treeDigest(p.testFiles));assert.equal(f.results,undefined);
  assert.throws(()=>validateEvidence(f,p));assert.ok(Buffer.byteLength(JSON.stringify(f))<=100000);
});
test('baseline failure retains baseline logs',async()=>{
  const p=payload();p.baseFiles={...p.baseFiles,'tests/broken.test.mjs':file("import {test} from 'node:test';import assert from 'node:assert/strict';test('broken',()=>assert.equal(1,2));")};p.testFiles={...p.testFiles,'tests/broken.test.mjs':p.baseFiles['tests/broken.test.mjs']};
  await assert.rejects(verify(p),e=>e.feedback.stage==='baseline' && /expected: 2/.test(e.feedback.logs.baseline));
});
test('sanitizer bounds and labels untrusted logs',()=>{
  const f=createFailureFeedback({message:'failed',feedback:{stage:'candidate',logs:{candidate:'\u001b[31m'+ 'x'.repeat(200000)}}},payload());
  assert.equal(f.untrustedData,true);assert.equal(f.logs.candidate.length,12000);assert.ok(Buffer.byteLength(JSON.stringify(f))<=100000);
});
test('no prior failed runs returns null without using content-supplied IDs',async()=>{
  const api={root:'/repos/a/b',configuration:async()=>({defaultBranch:'main'}),get:async path=>{assert.match(path,/workflows\/heal-publish.yml\/runs/);return {total_count:0,workflow_runs:[]};}};
  assert.equal(await loadFailureFeedback(api,{runId:666}),null);
});
test('bounded history fails closed',async()=>{
  let calls=0;
  const api={root:'/repos/a/b',configuration:async()=>({defaultBranch:'main'}),get:async()=>{calls++;return {total_count:3001,workflow_runs:Array.from({length:100},(_,i)=>({id:calls*100+i,conclusion:'success'}))};}};
  await assert.rejects(loadFailureFeedback(api,{}),/bounded lookup/);
  assert.equal(calls,30);
});
test('history past one hundred runs is paginated and exactly 3000 remains supported',async()=>{
  for(const total of [101,3000]) {
    let calls=0;
    const api={root:'/repos/a/b',configuration:async()=>({defaultBranch:'main'}),get:async path=>{calls++;assert.ok(path.endsWith(`page=${calls}`));return {total_count:total,workflow_runs:Array.from({length:Math.min(100,total-(calls-1)*100)},(_,i)=>({id:calls*100+i,conclusion:'success'}))};}};
    assert.equal(await loadFailureFeedback(api,{}),null);assert.equal(calls,Math.ceil(total/100));
  }
});
test('a failure from another workflow is rejected before artifact download',async()=>{
  const api={root:'/repos/a/b',configuration:async()=>({defaultBranch:'main'}),get:async path=>path.includes('/workflows/')?{total_count:1,workflow_runs:[{id:12,conclusion:'failure'}]}:{path:'.github/workflows/evil.yml',event:'workflow_run',head_branch:'main',conclusion:'failure'}};
  await assert.rejects(loadFailureFeedback(api,{}),/Untrusted failure run/);
});
// A minimal single-file stored ZIP exercises the actual unzip reader on Linux CI.
function zipJson(value) {
  const bytes=Buffer.from(JSON.stringify(value)),name=Buffer.from('failure.json');let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+bytes.length,16);
  return Buffer.concat([local,name,bytes,central,name,end]);
}
test('downloaded feedback is matched to exact authorization and delivered as untrusted data',{skip:!!spawnSync('unzip',['-v']).error},async t=>{
  const p=payload(),feedback=createFailureFeedback({message:'candidate failed',feedback:{stage:'candidate',logs:{candidate:'expected: 5 actual: 0'}}},p);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url==='https://api.github.com/repos/a/b/actions/artifacts/9/zip'){assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://artifact.example/failure.zip'}});}
    assert.equal(url,'https://artifact.example/failure.zip');assert.equal(options.headers,undefined);return new Response(zipJson(feedback));
  });
  const api={root:'/repos/a/b',origin:'https://api.github.com',token:'test-token',configuration:async()=>({defaultBranch:'main'}),get:async path=>{
    if(path.includes('/workflows/'))return {total_count:1,workflow_runs:[{id:12,conclusion:'failure'}]};
    if(path.includes('/artifacts?'))return {total_count:1,artifacts:[{id:9,name:'heal-failure',expired:false,size_in_bytes:2000}]};
    return {path:'.github/workflows/heal-publish.yml',event:'workflow_run',head_branch:'main',conclusion:'failure'};
  }};
  const loaded=await loadFailureFeedback(api,p.authorization);assert.equal(loaded.runId,12);assert.equal(loaded.untrustedData,true);assert.match(loaded.logs.candidate,/expected: 5/);
  assert.equal(await loadFailureFeedback(api,{...p.authorization,testHead:'changed'}),null);
  assert.equal(await loadFailureFeedback(api,{...p.authorization,scopeApproval:44}),null);
});
