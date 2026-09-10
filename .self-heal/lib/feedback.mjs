import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, sameAuthorization } from './policy.mjs';

const LIMIT=100000;
const clean=(value,limit=12000)=>{
  let text=String(value??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,limit);
  while(Buffer.byteLength(text)>limit) text=text.slice(0,-1);
  return text;
};
export function createFailureFeedback(error,payload={}) {
  const prior=error.feedback??{};
  const files=payload.testFiles;
  const feedback={version:1,kind:'verification-failure',untrustedData:true,
    authorization:payload.authorization??prior.authorization??null,
    stage:clean(prior.stage??'verification',100),reason:clean(error.message??error,2000),
    candidateDigest:payload.candidate?digest(JSON.stringify(payload.candidate)):prior.candidateDigest??null,
    testDigest:files?digest(JSON.stringify(Object.keys(files).sort().map(p=>[p,files[p].mode,files[p].content]))):prior.testDigest??null,
    logs:Object.fromEntries(Object.entries(prior.logs??{}).slice(0,3).map(([k,v])=>[clean(k,50),clean(v)]))};
  if(Buffer.byteLength(JSON.stringify(feedback))>LIMIT) throw new Error('Failure feedback exceeds size limit');
  return feedback;
}

async function readArtifact(api,artifact) {
  const r=await fetch(`${api.origin}${api.root}/actions/artifacts/${artifact.id}/zip`,{headers:{Authorization:`Bearer ${api.token}`,Accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const location=r.headers.get('location');
  if(r.status!==302 || !location?.startsWith('https://')) throw new Error('Invalid failure artifact download');
  const download=await fetch(location,{signal:AbortSignal.timeout(30000)});
  if(!download.ok) throw new Error('Failure artifact download failed');
  const chunks=[];let size=0;
  for await(const chunk of download.body) {size+=chunk.length;if(size>LIMIT) throw new Error('Failure artifact too large');chunks.push(chunk);}
  const dir=await mkdtemp(join(tmpdir(),'heal-feedback-'));
  try {
    const path=join(dir,'failure.zip');await writeFile(path,Buffer.concat(chunks));
    return JSON.parse(execFileSync('unzip',['-p',path,'failure.json'],{encoding:'utf8',timeout:10000,maxBuffer:LIMIT}));
  } finally {await rm(dir,{recursive:true,force:true});}
}

// Only Actions' trusted workflow listing supplies run IDs. No issue, PR, or model
// content may select an artifact. Feedback is diagnostic data, never authority.
export async function loadFailureFeedback(api,authorization) {
  const config=await api.configuration();
  const history=[];
  for(let page=1;page<=30;page++) {
    const response=await api.get(`${api.root}/actions/workflows/heal-publish.yml/runs?status=completed&per_page=100&page=${page}`);
    if(!Array.isArray(response.workflow_runs) || response.workflow_runs.length>100) throw new Error('Invalid failure history page');
    history.push(...response.workflow_runs);
    if(response.workflow_runs.length<100) break;
    if(page===30 && (!Number.isSafeInteger(response.total_count) || response.total_count>3000)) throw new Error('Failure history exceeds bounded lookup; cannot safely select feedback');
  }
  const runs=history.filter(r=>['failure','cancelled'].includes(r.conclusion)).sort((a,b)=>b.id-a.id);
  let unavailable=false;
  for(const listed of runs) {
    if(!Number.isSafeInteger(listed.id)) throw new Error('Invalid failure run ID');
    const run=await api.get(`${api.root}/actions/runs/${listed.id}`);
    if(run.path!=='.github/workflows/heal-publish.yml' || run.event!=='workflow_run' || run.head_branch!==config.defaultBranch || !['failure','cancelled'].includes(run.conclusion)) throw new Error('Untrusted failure run');
    const response=await api.get(`${api.root}/actions/runs/${listed.id}/artifacts?per_page=100`);
    if(!Array.isArray(response.artifacts) || response.total_count>100) throw new Error('Ambiguous failure artifacts');
    const matches=response.artifacts.filter(a=>a.name==='heal-failure');
    if(!matches.length) continue;
    if(matches.length!==1 || matches[0].size_in_bytes>LIMIT) throw new Error('Ambiguous or oversized failure artifact');
    if(matches[0].expired) {unavailable=true;continue;}
    const feedback=await readArtifact(api,matches[0]);
    if(feedback.version!==1 || feedback.kind!=='verification-failure' || !feedback.authorization) throw new Error('Invalid failure feedback');
    try {sameAuthorization(feedback.authorization,authorization);} catch {continue;}
    return {...createFailureFeedback({message:feedback.reason,feedback}),runId:listed.id};
  }
  return unavailable?{unavailable:true,untrustedData:true,reason:'Some older failure artifacts expired. No matching retained feedback was found.'}:null;
}
