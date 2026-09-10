import test from 'node:test';
import assert from 'node:assert/strict';
import {finishDiscussion,recordPublication} from '../lib/lifecycle.mjs';
import {readState} from '../lib/state.mjs';
import {digest} from '../lib/policy.mjs';
const policy={version:1,enabled:true,roles:{administrators:[1],maintainers:[2],testOwners:[3]},implementationPaths:['src/'],testPaths:['test/'],maxFiles:10,maxBytes:1000};
function fixture(stage='discuss',conclusion='success') {
  const issue={number:1,body:'Trusted current issue body'};
  const intent={id:'intent-22',type:'intent',commandId:'22',issue:1,testPr:3,kind:stage,stage,workflow:stage==='fix'?'heal-implement.lock.yml':'heal-triage.lock.yml',base:'base',defaultBranch:'main',scope:digest(issue.body),policyDigest:digest(JSON.stringify(policy))};
  let data={version:1,events:[intent]},pending,head='head';
  const run={id:11,event:stage==='fix'?'workflow_run':'workflow_dispatch',path:stage==='fix'?'.github/workflows/heal-publish.yml':'.github/workflows/heal-triage.lock.yml',display_title:stage==='fix'?'Heal publication for Heal implementation test PR #3 command #22':'Heal discussion issue #1 command #22',repository:{full_name:'owner/repo'},head_sha:'base',head_branch:'main',run_attempt:1,status:'completed',conclusion,html_url:'https://github.com/owner/repo/actions/runs/11'};
  const api={root:'/repo',repository:'owner/repo',messages:[],runs:[run],scopeCalls:0,
    configuration:async()=>({defaultBranch:'main',base:'base',policy}),
    async scope(){this.scopeCalls++;return {issue,scope:digest(issue.body),policy,modelScope:'arbitrary-hash'};},
    list:async()=>[],
    async get(path){
      if(path.endsWith('/git/ref/heads/heal-state'))return {object:{sha:head}};
      if(path.includes('/contents/state.json'))return {content:Buffer.from(JSON.stringify(data)).toString('base64')};
      if(path.includes('/git/commits/'))return {tree:{sha:'tree'}};
      if(path.includes('/actions/'))return {total_count:this.totalCount??this.runs.length,workflow_runs:this.runs};
      throw new Error(path);
    },
    async post(path,body){if(path.endsWith('/comments'))this.messages.push(body.body);if(path.endsWith('/git/blobs')){const parsed=JSON.parse(body.content);if(parsed.version===1)pending=parsed;}return {sha:'newhead'};},
    async request(path,method){assert.equal(method,'PATCH');data=pending;head+='a';}
  };
  return {api,event:{action:'completed',workflow_run:run},run,intent,issue};
}
test('successful discussion posts approval hashes calculated from trusted issue and policy',async()=>{
  const {api,event,issue}=fixture();assert.equal((await finishDiscussion(api,event)).status,'recorded');
  assert.match(api.messages[0],new RegExp(`/heal accept ${digest(issue.body)} ${digest(JSON.stringify(policy))}`));
  assert.doesNotMatch(api.messages[0],/arbitrary-hash/);assert.equal(api.scopeCalls,1);
  assert.ok((await readState(api)).events.some(e=>e.type==='completed'));
  assert.equal((await readState(api)).events.at(-1).type,'notified');
  await finishDiscussion(api,event);assert.equal(api.messages.length,1);
});
test('failed discussion records completion without offering scope approval',async()=>{
  const {api,event}=fixture('discuss','failure');await finishDiscussion(api,event);
  assert.match(api.messages[0],/failure/);assert.doesNotMatch(api.messages[0],/heal accept|Scope proposal/);assert.equal(api.scopeCalls,0);
});
test('issue changed during discussion requires another discussion and supplies no stale approval',async()=>{
  const {api,event,issue}=fixture();issue.body='Changed scope';await finishDiscussion(api,event);
  assert.match(api.messages[0],/changed during discussion/);assert.doesNotMatch(api.messages[0],/heal accept/);
});
test('publication failure releases fix stage exactly once and provides explicit retry command',async()=>{
  const {api,event}=fixture('fix','failure');assert.equal((await recordPublication(api,event)).status,'recorded');
  const completed=(await readState(api)).events.at(-1);assert.equal(completed.stage,'publication');assert.equal(completed.type,'completed');assert.equal(completed.commandId,'22');
  assert.match(api.messages[0],/\/heal fix 3/);assert.equal((await recordPublication(api,event)).status,'duplicate');assert.equal(api.messages.length,1);
});
for(const [field,value] of [['event','workflow_dispatch'],['path','.github/workflows/evil.yml'],['head_branch','other'],['head_sha','other'],['run_attempt',2],['id',0]]) {
  test(`publication rejects untrusted ${field}`,async()=>{
    const {api,event,run}=fixture('fix');run[field]=value;
    assert.equal((await recordPublication(api,event)).status,'ignored');assert.equal((await readState(api)).events.length,1);assert.equal(api.messages.length,0);
  });
}
test('publication requires unique API run with exact ID',async()=>{
  for(const duplicate of [false,true]){
    const {api,event,run}=fixture('fix');api.runs=duplicate?[run,{...run,id:12}]:[{...run,id:12}];
    await assert.rejects(recordPublication(api,event),/Ambiguous publication/);assert.equal((await readState(api)).events.length,1);
  }
});
test('publication refuses bounded history overflow without releasing stage',async()=>{
  const {api,event}=fixture('fix');api.runs=Array.from({length:100},(_,id)=>({id,display_title:'Other command'}));api.totalCount=3001;await assert.rejects(recordPublication(api,event),/history/);assert.equal((await readState(api)).events.length,1);
});
test('publication traverses multiple history pages before releasing matching command',async()=>{
  const {api,event,run}=fixture('fix');const originalGet=api.get;let pages=0;
  api.get=async function(path){if(path.includes('/actions/')){pages++;return {total_count:101,workflow_runs:pages===1?Array.from({length:100},(_,id)=>({id:id+100,display_title:'Other command'})):[run]};}return originalGet.call(this,path);};
  assert.equal((await recordPublication(api,event)).status,'recorded');assert.equal(pages,2);assert.equal((await readState(api)).events.at(-1).stage,'publication');
});
