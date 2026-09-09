import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../lib/verification.mjs';
const f=content=>({content:Buffer.from(content).toString('base64'),mode:'100644'});
test('production Docker verifier runs baseline/red/green as an unprivileged user',{
  skip:process.env.HEAL_DOCKER_TEST!=='1',timeout:180000
},async()=>{
  const baseFiles={
    'src/math.mjs':f('export const add=(a,b)=>a-b;'),
    'tests/base.test.mjs':f("import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/math.mjs';test('zero',()=>assert.equal(add(0,0),0));")
  };
  const testFiles={...baseFiles,'tests/new.test.mjs':f("import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/math.mjs';test('sum',()=>assert.equal(add(2,3),5));")};
  const policy={version:1,enabled:true,roles:{administrators:[1],maintainers:[1],testOwners:[1]},implementationPaths:['src/'],testPaths:['tests/'],maxFiles:10,maxBytes:10000};
  const result=await verify({baseFiles,testFiles,policy,authorization:{},candidate:{changes:[{path:'src/math.mjs',content:'export const add=(a,b)=>a+b;'}]}},{sandbox:'docker'});
  assert.equal(result.sandbox,'docker');assert.equal(result.results.testCount,2);
});
