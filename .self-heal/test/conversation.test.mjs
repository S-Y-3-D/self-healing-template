import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionContext,scopeProposal,testRevisionContext } from '../lib/conversation.mjs';
import { digest } from '../lib/policy.mjs';

function fake() {
  const policy={version:1,enabled:true,roles:{maintainers:[2],administrators:[3],testOwners:[4]},implementationPaths:['src/'],testPaths:['tests/'],maxFiles:10,maxBytes:100000};
  const issue={number:1,state:'open',body:'Fix behavior. See #2 and foreign/repo#99',user:{id:2,type:'User'}};
  const scope=digest(issue.body),base='a'.repeat(40),head='b'.repeat(40);
  const pr={number:2,state:'open',body:`Heal-Issue: #1\nHeal-Scope: ${scope}`,base:{sha:base,repo:{full_name:'o/r'}},head:{sha:head,repo:{full_name:'o/r'}}};
  const c={issue,policy,scope,base,repository:'o/r',comments:[{id:1,body:`/heal accept ${scope} ${digest(JSON.stringify(policy))}`,user:{id:2,type:'User'}}]};
  const api={root:'/repos/o/r',repository:'o/r',c,pr,seen:[],scope:async()=>structuredClone(c),
    get:async path=>{api.seen.push(path);if(path.endsWith('/issues/1'))return issue;if(path.endsWith('/issues/2'))return {...pr,pull_request:{}};if(path.endsWith('/pulls/2'))return pr;if(path.includes('/compare/'))return {merge_base_commit:{sha:base}};throw new Error('unexpected '+path);},
    list:async path=>{api.seen.push(path);if(path.endsWith('?state=open'))return [pr];if(path.endsWith('/files'))return [{filename:'tests/a.test.mjs',status:'added'}];if(path.endsWith('/reviews'))return [{id:10,state:'CHANGES_REQUESTED',body:'Keep this objection',user:{id:4,type:'User'}}];return [{id:20,body:'Last paginated comment',user:{id:3,type:'Bot'}}];},
    snapshot:async sha=>sha===base?{}:{'tests/a.test.mjs':{content:Buffer.from('test').toString('base64'),mode:'100644'}}};
  return api;
}
test('discussion preserves full thread identities, reviews, and configured human roles',async()=>{
  const api=fake(),c=await discussionContext(api,1);
  assert.equal(c.pullRequests.length,1);
  assert.equal(c.comments[0].authority,'maintainer');
  assert.deepEqual(c.pullRequests[0].reviewComments[0].policyRoles,[]);
  assert.equal(c.pullRequests[0].reviews[0].body,'Keep this objection');
  assert.equal(api.seen.some(p=>p.includes('99')),false);
});
test('pagination failures and oversized conversation block instead of truncating',async()=>{
  const api=fake();await assert.rejects(discussionContext(api,1,{maxChars:100}),/nothing was truncated/);
  api.list=async()=>{throw new Error('Pagination limit reached');};
  await assert.rejects(discussionContext(api,1),/Pagination/);
});
test('proposal fingerprints are calculated from current issue and policy',async()=>{
  const api=fake();const c=await discussionContext(api,1);c.scope='forged';
  assert.ok(scopeProposal(c).includes(`/heal accept ${digest(c.issue.body)} ${digest(JSON.stringify(c.policy))}`));
});
test('test revision allows requested changes without test approval and provides exact snapshot',async()=>{
  const c=await testRevisionContext(fake(),1,2);
  assert.equal(c.pr.head.sha,'b'.repeat(40));assert.ok(c.testFiles['tests/a.test.mjs']);
  assert.equal(c.reviews[0].state,'CHANGES_REQUESTED');
});
test('test revision rejects foreign heads, implementation changes and absent scope approval',async()=>{
  let api=fake();api.pr.head.repo.full_name='fork/r';await assert.rejects(testRevisionContext(api,1,2),/this repository/);
  api=fake();api.snapshot=async()=>({'src/a.mjs':{content:'eA==',mode:'100644'}});await assert.rejects(testRevisionContext(api,1,2),/changes no tests/);
  api=fake();api.c.comments=[];await assert.rejects(testRevisionContext(api,1,2),/scope approval/);
});
