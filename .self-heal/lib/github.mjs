import { authorize, authorizeScope, digest, sameAuthorization } from './policy.mjs';
import { validateFiles, validateEvidence, applyCandidate } from './verification.mjs';

export class GitHub {
  constructor(repository,token,origin='https://api.github.com') {
    if(!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
    this.repository=repository;this.token=token;this.origin=origin;this.root=`/repos/${repository}`;
  }
  async request(path,method='GET',body) {
    const url=new URL(path,this.origin);
    if(url.origin!==new URL(this.origin).origin) throw new Error('Foreign API URL');
    const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(this.token?{Authorization:`Bearer ${this.token}`}:{})},
      ...(body ? {body:JSON.stringify(body)}:{})});
    if(!response.ok) throw new Error(`GitHub API ${method} failed (${response.status})`);
    return response;
  }
  async get(path) {return (await this.request(path)).json();}
  async post(path,body) {return (await this.request(path,'POST',body)).json();}
  async list(path) {
    let next=path+(path.includes('?')?'&':'?')+'per_page=100';const values=[];
    for(let i=0;next && i<30;i++) {
      const r=await this.request(next);const page=await r.json();
      if(!Array.isArray(page)) throw new Error('Expected paginated array');values.push(...page);
      next=r.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1];
    }
    if(next) throw new Error('Pagination limit reached; refusing incomplete authorization');return values;
  }
  async configuration() {
    const repo=await this.get(this.root);
    const ref=await this.get(`${this.root}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    const base=ref.object.sha;
    const file=await this.get(`${this.root}/contents/.self-heal/policy.json?ref=${base}`);
    return {base,defaultBranch:repo.default_branch,policy:JSON.parse(Buffer.from(file.content,'base64').toString('utf8'))};
  }
  async scope(issueNumber) {
    const config=await this.configuration();
    const issue=await this.get(`${this.root}/issues/${positive(issueNumber)}`);
    const comments=await this.list(`${this.root}/issues/${issue.number}/comments`);
    return {...config,issue,comments,scope:digest(issue.body??''),repository:this.repository};
  }
  async context(testPr) {
    const pr=await this.get(`${this.root}/pulls/${positive(testPr)}`);
    const metadata=parseProposal(pr.body??'');
    const c=await this.scope(metadata.issue);
    c.scope=metadata.scope;c.pr=pr;
    c.files=await this.list(`${this.root}/pulls/${pr.number}/files`);
    c.reviews=await this.list(`${this.root}/pulls/${pr.number}/reviews`);
    // A PR base field follows main; compare merge-base as well to reject stale branches.
    const comparison=await this.get(`${this.root}/compare/${c.base}...${pr.head.sha}`);
    if(comparison.merge_base_commit?.sha!==c.base) throw new Error('Test branch must contain the current base');
    c.authorization=authorize(c);return c;
  }
  async snapshot(sha) {
    if(!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid commit');
    const tree=await this.get(`${this.root}/git/trees/${sha}?recursive=1`);
    if(tree.truncated || tree.tree.length>2000) throw new Error('Repository snapshot exceeds supported size');
    const files={};
    for(const item of tree.tree) {
      if(item.type==='tree') continue;
      if(item.type!=='blob' || !['100644','100755'].includes(item.mode)) throw new Error('Links and submodules are unsupported');
      if(item.size>1000000) throw new Error('File exceeds snapshot limit');
      const blob=await this.get(`${this.root}/git/blobs/${item.sha}`);
      files[item.path]={content:blob.content.replace(/\s/g,''),mode:item.mode};
    }
    validateFiles(files);return files;
  }
  async payload(testPr,candidate,expected) {
    const c=await this.context(testPr);
    if(expected) sameAuthorization(expected,c.authorization);
    const [baseFiles,testFiles]=await Promise.all([this.snapshot(c.base),this.snapshot(c.pr.head.sha)]);
    return {authorization:c.authorization,policy:c.policy,baseFiles,testFiles,candidate};
  }
}
export function positive(value) {
  if(!/^[1-9][0-9]*$/.test(String(value))) throw new Error('Expected a positive issue/PR number');return Number(value);
}
export function parseProposal(body) {
  const issues=[...body.matchAll(/^Heal-Issue: #(\d+)$/gm)];
  const scopes=[...body.matchAll(/^Heal-Scope: ([a-f0-9]{64})$/gm)];
  if(issues.length!==1 || scopes.length!==1) throw new Error('Test PR needs one Heal-Issue and Heal-Scope line');
  return {issue:positive(issues[0][1]),scope:scopes[0][1]};
}
export function assertPublishable(e,repository) {
  if(e.sandbox!=='docker') throw new Error('Publication requires Docker verification');
  if(e.authorization.repository!==repository) throw new Error('Wrong evidence repository');
}
export async function publish(api,evidence,runId) {
  assertPublishable(evidence,api.repository);
  if(!/^[0-9]+$/.test(String(runId))) throw new Error('Expected trusted run ID');
  const p=await api.payload(evidence.authorization.testPr,evidence.candidate,evidence.authorization);
  validateEvidence(evidence,p);
  const files=applyCandidate(p.testFiles,p.candidate,p.policy);
  const ledger={...evidence,logs:undefined,candidate:undefined,runId,verifiedAt:new Date().toISOString()};
  const ledgerPath=`.self-heal/ledger/${runId}.json`;
  files[ledgerPath]={content:Buffer.from(JSON.stringify(ledger,null,2)+'\n').toString('base64'),mode:'100644'};
  // Build the final tree relative to main: approved tests + candidate + controller-owned ledger.
  const entries=[];
  for(const path of new Set([...Object.keys(p.baseFiles),...Object.keys(files)])) {
    if(JSON.stringify(files[path])===JSON.stringify(p.baseFiles[path])) continue;
    if(!files[path]) entries.push({path,mode:p.baseFiles[path].mode,type:'blob',sha:null});
    else {const blob=await api.post(`${api.root}/git/blobs`,{content:files[path].content,encoding:'base64'});entries.push({path,mode:files[path].mode,type:'blob',sha:blob.sha});}
  }
  const baseCommit=await api.get(`${api.root}/git/commits/${p.authorization.base}`);
  const tree=await api.post(`${api.root}/git/trees`,{base_tree:baseCommit.tree.sha,tree:entries});
  const commit=await api.post(`${api.root}/git/commits`,{message:`fix: address issue #${p.authorization.issue}`,tree:tree.sha,parents:[p.authorization.base]});
  // Final fresh authorization check before creating a visible branch.
  const fresh=await api.context(p.authorization.testPr);sameAuthorization(p.authorization,fresh.authorization);
  const branch=`heal/fix-${p.authorization.issue}-${runId}`;
  await api.post(`${api.root}/git/refs`,{ref:`refs/heads/${branch}`,sha:commit.sha});
  return api.post(`${api.root}/pulls`,{title:`Fix #${p.authorization.issue}: verified repair`,head:branch,base:fresh.defaultBranch,draft:true,
    body:`Closes #${p.authorization.issue}\n\nHeal-Test-PR: #${p.authorization.testPr}\nHeal-Run: ${runId}\n\nApproved tests and implementation verified before publication.\nLedger: \`${ledgerPath}\`\n\nHuman implementation review is required. Tests passing are evidence, not a correctness guarantee.`});
}
export { authorizeScope };
