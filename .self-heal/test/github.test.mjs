import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GitHub, parseProposal, assertPublishable } from '../lib/github.mjs';

test('test proposal metadata is explicit and unique',()=>{
  assert.deepEqual(parseProposal('Discussion\nHeal-Issue: #12\nHeal-Scope: '+ 'a'.repeat(64)),{issue:12,scope:'a'.repeat(64)});
  assert.throws(()=>parseProposal('Heal-Issue: #1\nHeal-Issue: #2\nHeal-Scope: '+'a'.repeat(64)));
  assert.throws(()=>parseProposal('please fix issue 12'));
});
test('API follows pagination so late revocations are not missed',async()=>{
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url.includes('page=2')) res.end('[{"id":2}]');
    else { res.setHeader('Link',`<http://127.0.0.1:${server.address().port}/items?page=2>; rel="next"`); res.end('[{"id":1}]'); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { const api=new GitHub('o/r','test',`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(await api.list('/items'),[{id:1},{id:2}]);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
test('API errors fail closed and do not expose token',async()=>{
  const server=createServer((req,res)=>{res.writeHead(403);res.end('no');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {const api=new GitHub('o/r','secret',`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(api.get('/denied'),{message:'GitHub API GET failed (403)'});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('publication refuses local-run or wrong repository evidence',()=>{
  assert.throws(()=>assertPublishable({sandbox:'local',authorization:{repository:'o/r'}},'o/r'),/Docker/);
  assert.throws(()=>assertPublishable({sandbox:'docker',authorization:{repository:'evil/r'}},'o/r'),/repository/);
});
