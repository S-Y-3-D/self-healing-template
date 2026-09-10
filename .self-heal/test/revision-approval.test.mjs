import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHub} from '../lib/github.mjs';
import {digest} from '../lib/policy.mjs';

const repository='owner/repository';
const base='a'.repeat(40),head='b'.repeat(40),oldHead='c'.repeat(40);
const policy={version:1,enabled:true,roles:{administrators:[1],maintainers:[2],testOwners:[3,4]},implementationPaths:['src/'],testPaths:['test/'],maxFiles:10,maxBytes:10000};
const issue={number:1,state:'open',body:'Repair the regression'};
const scope=digest(issue.body);
const metadata=`Heal-Issue: #1\nHeal-Scope: ${scope}`;
const human=id=>({id,type:'User'});
const review=(id,user,state,commit_id)=>({id,user:human(user),state,commit_id});
function fixture(){
 const current={number:20,state:'open',body:`${metadata}\nHeal-Command: 90\nHeal-Revises: #19`,head:{sha:head,repo:{full_name:repository}},base:{sha:base,repo:{full_name:repository}}};
 const prior={...structuredClone(current),number:19,body:metadata,head:{sha:oldHead,repo:{full_name:repository}}};
 const intent={id:'intent-90',type:'intent',commandId:'90',stage:'tests',issue:1,scope,base,revisionPr:19};
 const data={current,prior,intent,reviews:[review(100,3,'APPROVED',head)],priorReviews:[review(50,3,'CHANGES_REQUESTED',oldHead)]};
 const api=new GitHub(repository,'unused');
 api.enforceStateSignature=false; // Canned state fixture; signed transport has independent state tests.
 api.get=async path=>{
  if(path===api.root)return {default_branch:'main'};
  if(path.endsWith('/git/ref/heads/main'))return {object:{sha:base}};
  if(path.includes('/contents/.self-heal/policy.json?'))return {content:Buffer.from(JSON.stringify(policy)).toString('base64')};
  if(path.endsWith('/git/ref/heads/heal-state'))return {object:{sha:'state'}};
  if(path.includes('/contents/state.json?'))return {content:Buffer.from(JSON.stringify({version:1,events:[data.intent,{id:'proposal-20',type:'proposal',prNumber:20,commandId:'90'},...(data.events??[])]})).toString('base64')};
  if(path.endsWith('/issues/1'))return issue;
  if(path.endsWith('/pulls/20'))return data.current;
  if(path.endsWith('/pulls/19'))return data.prior;
  const number=Number(path.match(/\/pulls\/(\d+)$/)?.[1]);if(data.ancestors?.[number])return data.ancestors[number];
  if(path.endsWith(`/compare/${base}...${head}`))return {merge_base_commit:{sha:base}};
  throw new Error(`Unexpected GET ${path}`);
 };
 api.list=async path=>{
  if(path.endsWith('/issues/1/comments'))return [{id:80,user:human(2),body:`/heal accept ${scope} ${digest(JSON.stringify(policy))}`,created_at:'now',updated_at:'now'}];
  if(path.endsWith('/pulls/20/files'))return [{filename:'test/regression.test.mjs',status:'added'}];
  if(path.endsWith('/pulls/20/reviews'))return data.reviews;
  if(path.endsWith('/pulls/19/reviews'))return data.priorReviews;
  const number=Number(path.match(/\/pulls\/(\d+)\/reviews$/)?.[1]);if(data.ancestorReviews?.[number])return data.ancestorReviews[number];
  throw new Error(`Unexpected LIST ${path}`);
 };
 return {api,data};
}

test('context accepts exact trusted revision metadata and current-head objection resolution',async()=>{
 const {api}=fixture();const context=await api.context(20);
 assert.equal(context.authorization.testPr,20);
 assert.equal(context.authorization.testHead,head);
 assert.deepEqual(context.authorization.testApprovals,[100]);
 assert.equal(context.previousReviews[0].state,'CHANGES_REQUESTED');
});
test('context requires exactly one trusted Heal-Command',async()=>{
 for(const body of [metadata,`${metadata}\nHeal-Command: 90\nHeal-Command: 90`,`${metadata}\nHeal-Command: 999\nHeal-Revises: #19`]){
  const {api,data}=fixture();data.current.body=body;
  await assert.rejects(api.context(20),/trusted Heal-Command|command does not match/);
 }
});
test('context rejects omitted or altered ancestry on a recorded revision',async()=>{
 for(const suffix of ['', '\nHeal-Revises: #18','\nHeal-Revises: #19\nHeal-Revises: #19']){
  const {api,data}=fixture();data.current.body=`${metadata}\nHeal-Command: 90${suffix}`;
  await assert.rejects(api.context(20),/revision metadata must match/);
 }
});
test('context rejects invented ancestry for a nonrevision command',async()=>{
 const {api,data}=fixture();delete data.intent.revisionPr;
 await assert.rejects(api.context(20),/revision metadata must match/);
});
test('context rejects command records for another stage issue scope or base',async()=>{
 for(const change of [{stage:'fix'},{issue:2},{scope:'d'.repeat(64)},{base:oldHead}]){
  const {api,data}=fixture();Object.assign(data.intent,change);
  await assert.rejects(api.context(20),/command does not match/);
 }
});
test('approval by another owner cannot resolve a prior reviewer objection',async()=>{
 const {api,data}=fixture();data.reviews=[review(100,4,'APPROVED',head)];
 await assert.rejects(api.context(20),/prior test reviewer must approve/);
});
test('prior reviewer approval must target the exact current head',async()=>{
 const {api,data}=fixture();data.reviews=[review(100,4,'APPROVED',head),review(101,3,'APPROVED',oldHead)];
 await assert.rejects(api.context(20),/prior test reviewer must approve/);
});
test('new request changes takes precedence over an earlier current-head approval',async()=>{
 const {api,data}=fixture();data.reviews.push(review(101,3,'CHANGES_REQUESTED',head));
 await assert.rejects(api.context(20),/Test review: changes requested/);
});

function multigeneration(){
 const {api,data}=fixture();
 data.events=[{id:'proposal-19',type:'proposal',prNumber:19,commandId:'89'},{id:'intent-89',type:'intent',commandId:'89',stage:'tests',issue:1,scope,base,revisionPr:18}];
 data.ancestors={18:{...structuredClone(data.prior),number:18,body:metadata}};
 data.ancestorReviews={18:[review(40,3,'CHANGES_REQUESTED',oldHead)]};
 data.priorReviews=[];
 data.reviews=[review(100,4,'APPROVED',head)];
 return {api,data};
}
test('persisted proposal ancestry preserves older objections despite removed or changed intermediate metadata',async()=>{
 for(const body of [metadata,`${metadata}\nHeal-Command: 999\nHeal-Revises: #17`,`${metadata}\nHeal-Command: 89`]){
  const {api,data}=multigeneration();data.prior.body=body;
  await assert.rejects(api.context(20),/prior test reviewer must approve/);
 }
});
test('older reviewer resolves persisted multi-generation objection by approving current head',async()=>{
 const {api,data}=multigeneration();data.prior.body=metadata;
 data.reviews.push(review(101,3,'APPROVED',head));
 const context=await api.context(20);
 assert.deepEqual(context.authorization.testApprovals,[100,101]);
 assert.equal(context.previousReviews[0].id,40);
});
test('persisted ancestry fails closed instead of truncating beyond depth limit',async()=>{
 const {api,data}=multigeneration();data.events=[];data.ancestors={};data.ancestorReviews={};
 for(let number=19;number>=8;number--){
  data.events.push({id:`proposal-${number}`,type:'proposal',prNumber:number,commandId:String(1000+number)},{id:`intent-${number}`,type:'intent',commandId:String(1000+number),stage:'tests',issue:1,scope,base,revisionPr:number-1});
  if(number!==19)data.ancestors[number]={...structuredClone(data.prior),number,body:metadata};
  data.ancestorReviews[number]=[];
 }
 await assert.rejects(api.context(20),/chain too long/);
});

test('current PR cannot switch to another valid initial command to hide its revision ancestry',async()=>{
 const {api,data}=multigeneration();
 data.events.push({id:'intent-91',type:'intent',commandId:'91',stage:'tests',issue:1,scope,base});
 data.current.body=`${metadata}\nHeal-Command: 91`;
 await assert.rejects(api.context(20),/command does not match/);
});
