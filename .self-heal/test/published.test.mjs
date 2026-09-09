import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPublished } from '../lib/published.mjs';
import { treeDigest } from '../lib/verification.mjs';
const file=s=>({content:Buffer.from(s).toString('base64'),mode:'100644'});
test('published content must match trusted artifact excluding the controller ledger',()=>{
  const files={'src/a.mjs':file('good'),'tests/a.test.mjs':file('test')};
  const evidence={treeDigest:treeDigest(files)};
  assert.doesNotThrow(()=>checkPublished({...files,'.self-heal/ledger/123.json':file('{}')},evidence,'123'));
  assert.throws(()=>checkPublished({...files,'src/a.mjs':file('tampered'),'.self-heal/ledger/123.json':file('{}')},evidence,'123'),/changed/);
  assert.throws(()=>checkPublished({...files,'.self-heal/ledger/456.json':file('{}')},evidence,'123'),/ledger/);
});
