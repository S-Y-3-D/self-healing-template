import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, digest, validateCandidate, latestReviews } from '../lib/policy.mjs';

export function fixture() {
  const scope = digest('Fix empty input');
  const c = {
    policy: { version: 1, enabled: true, roles: { maintainers: [10], testOwners: [20], administrators: [30] },
      implementationPaths: ['src/'], testPaths: ['tests/'], maxFiles: 10, maxBytes: 100000 },
    issue: { number: 1, title: 'Bug', body: 'Fix empty input', state: 'open' },
    scope,
    comments: [{ id: 1, body: `/heal accept ${scope}`, user: { id: 10, type: 'User' } }],
    reviews: [{ id: 2, state: 'APPROVED', commit_id: 'a'.repeat(40), user: { id: 20, type: 'User' } }],
    pr: { number: 2, state: 'open', head: { sha: 'a'.repeat(40), repo: { full_name: 'o/r' } },
      base: { sha: 'b'.repeat(40), repo: { full_name: 'o/r' } } },
    base: 'b'.repeat(40), repository: 'o/r',
    files: [{ filename: 'tests/empty.test.mjs', status: 'added' }]
  };
  c.comments[0].body += ` ${digest(JSON.stringify(c.policy))}`;
  return c;
}

test('approved exact head authorizes implementation', () => {
  assert.equal(authorize(fixture()).testHead, 'a'.repeat(40));
});
for (const [name, mutate, reason] of [
  ['stale test review', c => c.pr.head.sha = 'c'.repeat(40), /review/i],
  ['changed issue scope', c => c.issue.body += ' also delete accounts', /scope/i],
  ['moved base', c => c.base = 'd'.repeat(40), /base/i],
  ['dismissed approval', c => c.reviews[0].state = 'DISMISSED', /review/i],
  ['changed authority requires new scope approval', c => c.policy.roles.testOwners = [21], /scope/i],
  ['bot approval', c => c.reviews[0].user.type = 'Bot', /review/i],
  ['foreign test branch', c => c.pr.head.repo.full_name = 'evil/r', /repository/i],
  ['production edits in test proposal', c => c.files.push({filename:'src/main.mjs', status:'modified'}), /test.only/i],
  ['renamed test from production', c => c.files[0] = {filename:'tests/main.mjs', previous_filename:'src/main.mjs', status:'renamed'}, /test.only/i],
  ['disabled installation', c => c.policy.enabled = false, /disabled/i]
]) test(`blocks ${name}`, () => { const c = fixture(); mutate(c); assert.throws(() => authorize(c), reason); });

test('unauthorized comments cannot pause or authorize', () => {
  const c = fixture(); c.comments.push({id: 3, body:'/heal pause',user:{id:99,type:'User'}});
  assert.doesNotThrow(() => authorize(c));
  c.comments[0].user.id = 99;
  assert.throws(() => authorize(c), /scope/i);
});
test('pause wins until explicit authorized resume; accept cannot clear pause', () => {
  const c = fixture();
  c.comments.push({id:3,body:'/heal pause',user:{id:30,type:'User'}});
  c.comments.push({id:4,body:`/heal accept ${c.scope} ${digest(JSON.stringify(c.policy))}`,user:{id:10,type:'User'}});
  assert.throws(() => authorize(c), /paused/i);
  c.comments.push({id:5,body:`/heal resume ${digest(JSON.stringify(c.policy))}`,user:{id:10,type:'User'}});
  assert.throws(() => authorize(c), /paused/i); // maintainer cannot override administrator pause
  c.comments.push({id:6,body:`/heal resume ${digest(JSON.stringify(c.policy))}`,user:{id:30,type:'User'}});
  assert.doesNotThrow(() => authorize(c));
});
test('revocation invalidates earlier acceptance', () => {
  const c = fixture(); c.comments.push({id:3,body:'/heal revoke',user:{id:10,type:'User'}});
  assert.throws(() => authorize(c), /scope/i);
});
test('comment edits cannot silently authorize scope', () => {
  const c = fixture(); c.comments[0].created_at='2026-01-01'; c.comments[0].updated_at='2026-01-02';
  assert.throws(() => authorize(c), /scope/i);
});
test('latest changes-requested supersedes approval, comments do not', () => {
  const c = fixture(); c.reviews.push({...c.reviews[0],id:3,state:'COMMENTED'});
  assert.doesNotThrow(() => authorize(c));
  c.reviews.push({...c.reviews[0],id:4,state:'CHANGES_REQUESTED'});
  assert.throws(() => authorize(c), /review/i);
  assert.equal(latestReviews(c.reviews).get(20).state,'CHANGES_REQUESTED');
});
test('an authorized outstanding objection blocks another owner approval', () => {
  const c = fixture(); c.policy.roles.testOwners.push(21);
  c.comments[0].body=`/heal accept ${c.scope} ${digest(JSON.stringify(c.policy))}`;
  c.reviews.push({...c.reviews[0],id:3,state:'CHANGES_REQUESTED',user:{id:21,type:'User'}});
  assert.throws(() => authorize(c), /changes requested/i);
});
test('candidate accepts implementation changes only', () => {
  const c = fixture();
  assert.equal(validateCandidate({changes:[{path:'src/main.mjs',content:'export const x = 1;'}]},c.policy).length,1);
});
for (const path of ['tests/x.mjs','.github/workflows/ci.yml','src/../tests/x','src\\x','/src/x','src/.git/config','src/x\n']) {
  test(`candidate rejects unsafe or protected path ${JSON.stringify(path)}`, () => {
    assert.throws(() => validateCandidate({changes:[{path,content:'x'}]},fixture().policy));
  });
}
test('candidate rejects duplicate paths, empty patches and oversized contents', () => {
  const p = fixture().policy;
  assert.throws(() => validateCandidate({changes:[]},p));
  assert.throws(() => validateCandidate({changes:[{path:'src/x',content:'a'},{path:'src/x',content:'b'}]},p));
  assert.throws(() => validateCandidate({changes:[{path:'src/x',content:'x'.repeat(100001)}]},p));
});
