import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSetup } from '../lib/setup.mjs';
import { generateKeyPairSync } from 'node:crypto';
const publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
function fake() {
  const policy={version:1,enabled:true,statePublicKey:publicKey,roles:{maintainers:[2],administrators:[3],testOwners:[4]},implementationPaths:['src/'],testPaths:['tests/'],maxFiles:10,maxBytes:100000};
  const paths=[];
  return {root:'/repos/o/r',repository:'o/r',policy,paths,list:async()=>[{id:7}],configuration:async()=>({policy,base:'a'.repeat(40),defaultBranch:'main'}),get:async path=>{
    paths.push(path);
    if(path.endsWith('/rulesets/7'))return {target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/heal-state'],exclude:[]}},rules:[{type:'deletion'},{type:'non_fast_forward'}]};
    if(path.endsWith('/environments/heal-control'))return {deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}};
    if(path.includes('/deployment-branch-policies'))return {total_count:1,branch_policies:[{type:'branch',name:'main'}]};
    if(path.endsWith('/secrets/HEAL_STATE_PRIVATE_KEY'))return {name:'HEAL_STATE_PRIVATE_KEY'};
    if(path.includes('/variables/'))return {value:'true'};
    if(path.includes('/secrets/'))return {name:'ANTHROPIC_API_KEY'};
    if(path.includes('/contents/'))return {content:Buffer.from('---\nengine:\n  model: claude-sonnet-5\n---\n').toString('base64')};
    if(path.endsWith('/permissions/workflow'))return {can_approve_pull_request_reviews:true};
    if(path.endsWith('/protection'))return {required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true,require_code_owner_reviews:true},required_status_checks:{contexts:['test','Heal authorization']},enforce_admins:{enabled:true}};
    if(path.includes('/environments/'))return {protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{type:'User',id:3}}]}]};
    throw new Error('unexpected');
  }};
}
test('audit reads remote configuration and names only',async()=>{
  const api=fake(),report=await auditSetup(api);assert.equal(report.ready,true);assert.equal(report.checks.length,10);
  assert.ok(api.paths.includes('/repos/o/r/actions/secrets/ANTHROPIC_API_KEY'));
  assert.ok(api.paths.includes('/repos/o/r/environments/heal-control/secrets/HEAL_STATE_PRIVATE_KEY'));
});
test('disabled copies and placeholder owners cannot be ready',async()=>{
  const api=fake();api.policy.enabled=false;assert.equal((await auditSetup(api)).ready,false);
  api.policy.enabled=true;api.policy.roles.maintainers=[1];assert.match((await auditSetup(api)).errors.join(),/placeholder/);
});
test('a solo human publication reviewer does not require prevent-self-review',async()=>{
  const api=fake(),get=api.get;
  api.get=async path=>path.endsWith('/environments/heal-publish')?{protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{type:'User',id:3}}]}]}:get(path);
  assert.equal((await auditSetup(api)).ready,true);
});
test('unreadable settings fail closed with individual actionable checks',async()=>{
  const api=fake();api.get=async()=>{throw new Error('GitHub API GET failed (403)');};
  const report=await auditSetup(api);assert.equal(report.ready,false);assert.equal(report.errors.length,8);
  assert.match(report.errors.join(),/Publication environment/);
});
test('signing public key must be an Ed25519 public PEM',async()=>{
  for(const key of [undefined,'placeholder',generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'})]) {
    const api=fake();api.policy.statePublicKey=key;
    assert.match((await auditSetup(api)).errors.join(),/PEM Ed25519/);
  }
});
test('signing environment rejects wildcard, tag, extra and protected-branch deployment access',async()=>{
  for(const branch of [{total_count:1,branch_policies:[{type:'branch',name:'*'}]},{total_count:1,branch_policies:[{type:'tag',name:'main'}]},{total_count:2,branch_policies:[{type:'branch',name:'main'},{type:'branch',name:'other'}]}]) {
    const api=fake(),get=api.get;api.get=async path=>path.includes('/deployment-branch-policies')?branch:get(path);
    assert.match((await auditSetup(api)).errors.join(),/exactly the default branch/);
  }
  const api=fake(),get=api.get;api.get=async path=>path.endsWith('/environments/heal-control')?{deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}}:get(path);
  assert.match((await auditSetup(api)).errors.join(),/custom deployment branch/);
});
test('state protection must prevent both deletion and force pushes without bypass',async()=>{
  for(const change of [{enforcement:'evaluate'},{bypass_actors:[{actor_id:1}]},{rules:[{type:'deletion'}]},{conditions:{ref_name:{include:['refs/heads/other'],exclude:[]}}},{conditions:{ref_name:{include:['~ALL'],exclude:['refs/heads/heal-state']}}}]) {
    const api=fake(),get=api.get;api.get=async path=>path.endsWith('/rulesets/7')?{...await get(path),...change}:get(path);
    assert.match((await auditSetup(api)).errors.join(),/State branch protection/);
  }
});
test('missing environment signing secret fails readiness',async()=>{
  const api=fake(),get=api.get;api.get=async path=>{if(path.endsWith('/secrets/HEAL_STATE_PRIVATE_KEY'))throw new Error('GitHub API GET failed (404)');return get(path);};
  assert.match((await auditSetup(api)).errors.join(),/State signing environment/);
});
