import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sameAuthorization } from './policy.mjs';
import { treeDigest } from './verification.mjs';

export function checkPublished(files,evidence,runId) {
  const copy={...files};const ledger=`.self-heal/ledger/${runId}.json`;
  if(!copy[ledger]) throw new Error('Missing expected ledger');delete copy[ledger];
  if(treeDigest(copy)!==evidence.treeDigest) throw new Error('Published files changed after verification');
}
export function isHealing(pr,files) {
  return pr.head.ref.startsWith('heal/fix-') || /^Heal-(Test-PR|Run):/m.test(pr.body??'')
    || files.some(f=>/^\.self-heal\/ledger\/\d+\.json$/.test(f.filename));
}
async function readEvidence(api,runId) {
  const run=await api.get(`${api.root}/actions/runs/${runId}`);
  const config=await api.configuration();
  if(run.path!=='.github/workflows/heal-publish.yml' || run.event!=='workflow_run' || run.conclusion!=='success' || run.head_branch!==config.defaultBranch) throw new Error('Untrusted publication run');
  const response=await api.get(`${api.root}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts=response.artifacts.filter(a=>a.name==='heal-verified' && !a.expired);
  if(artifacts.length!==1 || response.total_count>100 || artifacts[0].size_in_bytes>10000000) throw new Error('Missing, expired or ambiguous verification artifact');
  const r=await fetch(`${api.origin}${api.root}/actions/artifacts/${artifacts[0].id}/zip`,{
    headers:{Authorization:`Bearer ${api.token}`,Accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(r.status!==302) throw new Error('Artifact download was not authorized');
  const location=r.headers.get('location');if(!location?.startsWith('https://')) throw new Error('Invalid artifact redirect');
  const download=await fetch(location,{signal:AbortSignal.timeout(30000)});
  if(!download.ok) throw new Error('Artifact download failed');
  const bytes=Buffer.from(await download.arrayBuffer());if(bytes.length>10000000) throw new Error('Artifact too large');
  const temp=await mkdtemp(join(tmpdir(),'heal-proof-'));
  try {
    const path=join(temp,'evidence.zip');await writeFile(path,bytes);
    // Stream only the named file; never extract archive paths or execute archive content.
    const json=execFileSync('unzip',['-p',path,'verified.json'],{encoding:'utf8',timeout:10000,maxBuffer:10000000});
    return JSON.parse(json);
  } finally {await rm(temp,{recursive:true,force:true});}
}
export async function refreshGates(api) {
  const prs=await api.list(`${api.root}/pulls?state=open`);
  for(const pr of prs) {
    const healing=isHealing(pr,await api.list(`${api.root}/pulls/${pr.number}/files`));
    const status={context:'Heal authorization',target_url:`https://github.com/${api.repository}/actions`};
    if(!healing) {
      await api.post(`${api.root}/statuses/${pr.head.sha}`,{...status,state:'success',description:'Ordinary PR: standard CI and human review apply'});
      continue;
    }
    await api.post(`${api.root}/statuses/${pr.head.sha}`,{...status,state:'pending',description:'Checking current approvals and verified artifact'});
    try {
      const test=pr.body?.match(/^Heal-Test-PR: #(\d+)$/m)?.[1];
      const run=pr.body?.match(/^Heal-Run: (\d+)$/m)?.[1];
      if(!test || !run) throw new Error('Missing fix metadata');
      const c=await api.context(test);
      const evidence=await readEvidence(api,run);
      sameAuthorization(evidence.authorization,c.authorization);
      checkPublished(await api.snapshot(pr.head.sha),evidence,run);
      await api.post(`${api.root}/statuses/${pr.head.sha}`,{...status,state:'success',description:'Current approvals and exact verified content match'});
    } catch(error) {
      await api.post(`${api.root}/statuses/${pr.head.sha}`,{...status,state:'failure',description:error.message.slice(0,140)});
      console.error(`PR #${pr.number}: ${error.message}`);
    }
  }
}
