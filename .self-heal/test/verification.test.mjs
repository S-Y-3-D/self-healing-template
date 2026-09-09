import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCandidate, treeDigest, verify, validateEvidence } from '../lib/verification.mjs';
const policy = {version:1,enabled:true,roles:{maintainers:[1],testOwners:[1],administrators:[1]},implementationPaths:['src/'],testPaths:['tests/'],maxFiles:10,maxBytes:100000};
const file = content => ({content:Buffer.from(content).toString('base64'),mode:'100644'});
const baseFiles = {'src/add.mjs':file('export const add = (a,b) => a-b;'), 'tests/add.test.mjs':file("import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/add.mjs'; test('zero',()=>assert.equal(add(0,0),0));")};
const testFiles = {...baseFiles,'tests/regression.test.mjs':file("import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/add.mjs'; test('adds positive values',()=>assert.equal(add(2,3),5));")};
const candidate = {changes:[{path:'src/add.mjs',content:'export const add = (a,b) => a+b;'}]};
const payload = () => ({policy,baseFiles,testFiles,candidate,authorization:{testHead:'a'.repeat(40)}});

test('real baseline red and candidate green produce bound evidence', async () => {
  const evidence = await verify(payload());
  assert.equal(evidence.results.baseline,'pass');
  assert.equal(evidence.results.regression,'expected-failure');
  assert.equal(evidence.results.candidate,'pass');
  assert.equal(evidence.testDigest,treeDigest(testFiles));
  assert.doesNotThrow(() => validateEvidence(evidence,payload()));
});
test('a candidate leaving regression broken cannot produce publication evidence', async () => {
  const p = payload(); p.candidate={changes:[{path:'src/add.mjs',content:'export const add = (a,b) => 0;'}]};
  await assert.rejects(verify(p),/candidate/i);
});
test('syntax errors are not accepted as a regression reproduction', async () => {
  const p=payload(); p.testFiles={...baseFiles,'tests/regression.test.mjs':file('this is not JavaScript!')};
  await assert.rejects(verify(p),/assertion/i);
});
test('no discovered tests cannot count as passing', async () => {
  const p=payload(); p.baseFiles={'src/add.mjs':baseFiles['src/add.mjs']};
  await assert.rejects(verify(p),/test/i);
});
test('publisher rejects altered candidate or fabricated result', async () => {
  const p=payload(); const e=await verify(p);
  assert.throws(()=>validateEvidence({...e,treeDigest:'wrong'},p),/digest/i);
  assert.throws(()=>validateEvidence({...e,results:{...e.results,candidate:'fail'}},p),/result/i);
  assert.throws(()=>validateEvidence(e,{...p,candidate:{changes:[{path:'src/add.mjs',content:'bad'}]}}),/digest/i);
});
test('materialization rejects symbolic links and path traversal', () => {
  assert.throws(()=>applyCandidate({'src/link':{content:'',mode:'120000'}},candidate,policy),/mode/i);
  assert.throws(()=>applyCandidate({'../escape':file('bad')},candidate,policy),/path/i);
});
test('test snapshot cannot smuggle a production change through an API race',async()=>{
  const p=payload(); p.testFiles={...testFiles,'src/add.mjs':file('export const add = () => 5;')};
  await assert.rejects(verify(p),/Test-only snapshot/);
});
