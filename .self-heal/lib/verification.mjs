import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, validateCandidate, sameAuthorization } from './policy.mjs';

export function validateFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 2000) throw new Error('Invalid snapshot');
  let bytes=0;
  for (const [path,f] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(s=>!s || s==='.' || s==='..' || s==='.git')) throw new Error('Unsafe snapshot path');
    if (!['100644','100755'].includes(f.mode)) throw new Error('Unsupported file mode: links and submodules are forbidden');
    if (typeof f.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content)) throw new Error('Invalid base64 snapshot');
    bytes+=Buffer.byteLength(f.content); if(bytes>10000000) throw new Error('Snapshot too large');
  }
}
export function treeDigest(files) {
  validateFiles(files);
  return digest(JSON.stringify(Object.keys(files).sort().map(path=>[path,files[path].mode,files[path].content])));
}
export function validateTestSnapshot(base,tests,policy) {
  validateFiles(base);validateFiles(tests);let changed=0;
  for(const path of new Set([...Object.keys(base),...Object.keys(tests)])) {
    if(JSON.stringify(base[path])===JSON.stringify(tests[path])) continue;
    if(!tests[path] || !policy.testPaths.some(prefix=>path.startsWith(prefix))) throw new Error('Test-only snapshot required');
    changed++;
  }
  if(!changed) throw new Error('Test proposal changes no tests');
}
export function applyCandidate(files,candidate,policy) {
  validateFiles(files);
  const result=structuredClone(files);
  for (const c of validateCandidate(candidate,policy)) {
    if(c.content===null) { if(!result[c.path]) throw new Error('Cannot delete absent file'); delete result[c.path]; }
    else result[c.path]={content:Buffer.from(c.content).toString('base64'),mode:result[c.path]?.mode ?? '100644'};
  }
  validateFiles(result); return result;
}
async function runSuite(files,policy,sandbox) {
  validateFiles(files);
  const names=Object.keys(files).filter(p=>policy.testPaths.some(t=>p.startsWith(t)) && p.endsWith('.test.mjs')).sort();
  if(!names.length) throw new Error('No test files discovered');
  const cwd=await mkdtemp(join(tmpdir(),'heal-verify-'));
  const container=`heal-${randomUUID()}`;
  try {
    await chmod(cwd,0o755);
    for(const [p,f] of Object.entries(files)) { await mkdir(dirname(join(cwd,p)),{recursive:true,mode:0o755}); await writeFile(join(cwd,p),Buffer.from(f.content,'base64'),{mode:f.mode==='100755'?0o755:0o644}); }
    const args=['--test','--test-reporter=tap',...names];
    const command=sandbox==='docker' ? 'docker' : process.execPath;
    const options=sandbox==='docker'
      ? ['run','--name',container,'--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=512m','--cpus=1','--user=1000:1000','--mount',`type=bind,src=${cwd},dst=/candidate,readonly`,'--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--workdir=/candidate','node:22-bookworm-slim','node',...args]
      : args;
    const r=spawnSync(command,options,{cwd,encoding:'utf8',timeout:120000,maxBuffer:2000000,
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}});
    if(r.error || r.signal || r.status===null) throw new Error('Test runner failed or timed out');
    const output=(r.stdout??'')+'\n'+(r.stderr??'');
    const count=Number(output.match(/^# tests (\d+)$/m)?.[1]??0);
    const skip=Number(output.match(/^# skipped (\d+)$/m)?.[1]??0)+Number(output.match(/^# todo (\d+)$/m)?.[1]??0);
    if(!count || skip) throw new Error('No tests or skipped tests in required suite');
    return {status:r.status, count, assertions:(output.match(/code: 'ERR_ASSERTION'/g)??[]).length,
      failures:Number(output.match(/^# fail (\d+)$/m)?.[1]??0), output};
  } finally {
    if(sandbox==='docker') spawnSync('docker',['rm','-f',container],{stdio:'ignore',timeout:10000});
    await rm(cwd,{recursive:true,force:true});
  }
}
export async function verifyTests(p,{sandbox='local'}={}) {
  validateTestSnapshot(p.baseFiles,p.testFiles,p.policy);
  const baseline=await runSuite(p.baseFiles,p.policy,sandbox);
  if(baseline.status!==0) throw new Error('Existing baseline tests fail');
  const regression=await runSuite(p.testFiles,p.policy,sandbox);
  if(regression.status===0 || regression.assertions===0 || regression.assertions!==regression.failures) throw new Error('Regression must fail on assertions only');
  return {baseline,regression};
}
export async function verify(p,{sandbox='local'}={}) {
  // local is for this package's controlled fixtures; the CLI always selects docker.
  const candidateFiles=applyCandidate(p.testFiles,p.candidate,p.policy);
  const {baseline,regression}=await verifyTests(p,{sandbox});
  const candidate=await runSuite(candidateFiles,p.policy,sandbox);
  if(candidate.status!==0 || candidate.count!==regression.count) throw new Error('Candidate tests failed or test count changed');
  return {version:1,authorization:p.authorization,candidate:p.candidate,
    candidateDigest:digest(JSON.stringify(p.candidate)),testDigest:treeDigest(p.testFiles),treeDigest:treeDigest(candidateFiles),
    results:{baseline:'pass',regression:'expected-failure',candidate:'pass',testCount:candidate.count},
    logs:{baseline:baseline.output,regression:regression.output,candidate:candidate.output},sandbox};
}
export function validateEvidence(e,p) {
  // Authenticity comes from the trusted same-run Actions artifact, not this JSON.
  validateTestSnapshot(p.baseFiles,p.testFiles,p.policy);
  sameAuthorization(e.authorization,p.authorization);
  if(e.version!==1 || e.results?.baseline!=='pass' || e.results?.regression!=='expected-failure' || e.results?.candidate!=='pass' || !(e.results?.testCount>0)) throw new Error('Invalid verification result');
  if(e.candidateDigest!==digest(JSON.stringify(p.candidate)) || e.testDigest!==treeDigest(p.testFiles) || e.treeDigest!==treeDigest(applyCandidate(p.testFiles,p.candidate,p.policy))) throw new Error('Verification digest mismatch');
}
