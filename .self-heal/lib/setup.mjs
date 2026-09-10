import { validatePolicy } from './policy.mjs';
import { createPublicKey } from 'node:crypto';

// Read-only audit. Names establish presence, never credential validity.
export async function auditSetup(api) {
  const errors=[],checks=[];
  const check=async(name,fn)=>{try {await fn();checks.push({name,ok:true});} catch(error) {const message=`${name}: ${error.message}`;errors.push(message);checks.push({name,ok:false,message});}};
  let config;
  await check('Repository policy',async()=>{
    config=await api.configuration();validatePolicy(config.policy);
    if(!config.policy.enabled) throw new Error('Set policy.enabled to true only after configuring your own numeric owner IDs and completing setup');
    if(Object.values(config.policy.roles).some(ids=>ids.includes(1))) throw new Error('Replace placeholder owner ID 1 with your own GitHub numeric human IDs');
  });
  await check('AI activation',async()=>{
    const variable=await api.get(`${api.root}/actions/variables/HEAL_ENABLED`);
    if(variable.value!=='true') throw new Error('Set the repository Actions variable HEAL_ENABLED=true after setup');
  });
  await check('Credential presence',async()=>{
    // This endpoint returns metadata only. Fetching a named secret avoids envelope pagination.
    const secret=await api.get(`${api.root}/actions/secrets/ANTHROPIC_API_KEY`);
    if(secret.name!=='ANTHROPIC_API_KEY') throw new Error('Add the ANTHROPIC_API_KEY repository Actions secret');
  });
  await check('Pinned model',async()=>{
    if(!config?.base) throw new Error('Cannot inspect model until remote policy is readable');
    for(const workflow of ['heal-triage','heal-tests','heal-implement']) {
      const file=await api.get(`${api.root}/contents/.github/workflows/${workflow}.md?ref=${config.base}`);
      const source=Buffer.from(file.content,'base64').toString('utf8');
      const frontmatter=source.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
      if(!frontmatter || !/^  model: ['"]?[a-z0-9][a-z0-9.-]*['"]?\s*$/m.test(frontmatter)) throw new Error(`Pin an explicit engine.model in ${workflow}.md and compile its workflow`);
    }
  });
  await check('Actions PR permissions',async()=>{
    const p=await api.get(`${api.root}/actions/permissions/workflow`);
    if(p.can_approve_pull_request_reviews!==true) throw new Error('Enable Allow GitHub Actions to create and approve pull requests in repository Actions settings; bot reviews still cannot authorize healing');
  });
  await check('Default branch protection',async()=>{
    if(!config?.defaultBranch) throw new Error('Cannot inspect default branch until repository configuration is readable');
    const p=await api.get(`${api.root}/branches/${encodeURIComponent(config.defaultBranch)}/protection`);
    const reviews=p.required_pull_request_reviews;
    if(!reviews || reviews.required_approving_review_count<1 || !reviews.dismiss_stale_reviews || !reviews.require_code_owner_reviews) throw new Error('Require human PR review, code-owner review, and stale review dismissal on the default branch');
    const contexts=[...(p.required_status_checks?.contexts??[]),...(p.required_status_checks?.checks??[]).map(x=>x.context)];
    if(!contexts.includes('Heal authorization') || !contexts.some(x=>x==='test' || x==='Template CI / test')) throw new Error('Require the emitted Template CI test and Heal authorization status checks');
    if(!p.enforce_admins?.enabled) throw new Error('Enforce branch protections for administrators');
    if(Object.values(reviews.bypass_pull_request_allowances??{}).some(x=>Array.isArray(x)&&x.length)) throw new Error('Remove PR protection bypass allowances');
  });
  await check('Publication environment',async()=>{
    const e=await api.get(`${api.root}/environments/heal-publish`);
    const required=e.protection_rules?.find(r=>r.type==='required_reviewers');
    if(!required?.reviewers?.some(r=>r.type==='User' && r.reviewer?.type==='User')) throw new Error('Create heal-publish with a required human reviewer');
  });
  await check('State public key',async()=>{
    try {
      if(typeof config?.policy?.statePublicKey!=='string' || !config.policy.statePublicKey.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error();
      if(createPublicKey(config.policy.statePublicKey).asymmetricKeyType!=='ed25519')throw new Error();
    } catch {throw new Error('Configure policy.statePublicKey with the PEM Ed25519 public key matching the heal-control signing secret');}
  });
  await check('State signing environment',async()=>{
    if(!config?.defaultBranch)throw new Error('Cannot inspect signing deployment branches until repository configuration is readable');
    const environment=await api.get(`${api.root}/environments/heal-control`);
    const policy=environment.deployment_branch_policy;
    if(policy?.custom_branch_policies!==true || policy.protected_branches!==false)throw new Error('Restrict heal-control to a custom deployment branch policy containing only the default branch');
    const branches=await api.get(`${api.root}/environments/heal-control/deployment-branch-policies?per_page=100`);
    if(branches.total_count!==1 || branches.branch_policies?.length!==1 || branches.branch_policies[0].type!=='branch' || branches.branch_policies[0].name!==config.defaultBranch)throw new Error('Allow exactly the default branch by its literal name in heal-control; no tags or wildcard patterns');
    const secret=await api.get(`${api.root}/environments/heal-control/secrets/HEAL_STATE_PRIVATE_KEY`);
    if(secret.name!=='HEAL_STATE_PRIVATE_KEY')throw new Error('Add HEAL_STATE_PRIVATE_KEY as a heal-control environment secret');
  });
  await check('State branch protection',async()=>{
    const summaries=await api.list(`${api.root}/rulesets?includes_parents=true`);
    let protectedState=false;
    for(const summary of summaries) {
      if(!Number.isSafeInteger(summary.id))throw new Error('Invalid repository ruleset ID');
      const ruleset=await api.get(`${api.root}/rulesets/${summary.id}`);
      const refs=ruleset.conditions?.ref_name;
      if(ruleset.target!=='branch' || ruleset.enforcement!=='active' || !Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length || refs?.exclude?.length || !refs?.include?.some(ref=>ref==='refs/heads/heal-state'||ref==='~ALL'))continue;
      const types=new Set((ruleset.rules??[]).map(rule=>rule.type));
      if(types.has('deletion')&&types.has('non_fast_forward'))protectedState=true;
    }
    if(!protectedState)throw new Error('Add an active branch ruleset covering heal-state with deletion and non-fast-forward prevention, no exclusions, and no bypass actors');
  });
  return {ready:errors.length===0,repository:api.repository,checks,errors,notice:'Read-only configuration audit. Secret names prove presence only; credentials, model access, and an actual protected run must still be validated.'};
}
