import {parseProposal,positive} from './github.mjs';
import {authorizeScope,digest,validatePolicy} from './policy.mjs';
import {readState,appendEvent,controlComments} from './state.mjs';
const workflows={discuss:'heal-triage.lock.yml',tests:'heal-tests.lock.yml',fix:'heal-implement.lock.yml'};
const stage=kind=>kind==='discuss'?'discuss':kind.includes('tests')?'tests':'fix';
const allowed=(p,u)=>u?.type==='User' && Number.isSafeInteger(u.id) && [...p.roles.administrators,...p.roles.maintainers].includes(u.id);
export function parseCommand(body) {
 const text=String(body??'').trim();let m;
 if(/^\/heal (discuss|tests|pause|revoke)$/.test(text)) return {kind:text.slice(6)};
 if((m=text.match(/^\/heal (revise-tests|fix|revise-fix) ([1-9][0-9]*)$/))) return {kind:m[1],target:positive(m[2])};
 if((m=text.match(/^\/heal (accept) ([a-f0-9]{64}) ([a-f0-9]{64})$/))) return {kind:m[1],scope:m[2],policy:m[3]};
 if((m=text.match(/^\/heal resume ([a-f0-9]{64})$/))) return {kind:'resume',policy:m[1]};
 return null;
}
async function testForFix(api,n) {const pr=await api.get(`${api.root}/pulls/${n}`);const m=[...(pr.body??'').matchAll(/^Heal-Test-PR: #([1-9][0-9]*)$/gm)];if(m.length!==1) throw new Error('Fix PR needs exactly one Heal-Test-PR');return positive(m[0][1]);}
async function issueForTest(api,n) {return parseProposal((await api.get(`${api.root}/pulls/${n}`)).body??'').issue;}
async function runs(api,id) {
 const result=[];for(let page=1;page<=30;page++){const data=await api.get(`${api.root}/actions/runs?event=workflow_dispatch&per_page=100&page=${page}`);result.push(...data.workflow_runs.filter(r=>r.display_title?.endsWith(` command #${id}`)));if(data.workflow_runs.length<100)return result;}throw new Error('Run history exceeds safe pagination');
}
export async function recordRun(api,event) {
 if(event.action!=='completed' || event.workflow_run?.event!=='workflow_dispatch') return {status:'ignored'};
 const run=event.workflow_run;const id=run.display_title?.match(/ command #([1-9][0-9]*)$/)?.[1];if(!id)return {status:'ignored'};
 const state=await readState(api);if(!state.events.some(e=>e.type==='intent'&&e.commandId===id)||state.events.some(e=>e.id===`run-${run.id}`))return {status:'ignored'};
 const intent=state.events.find(e=>e.type==='intent'&&e.commandId===id);
 if(run.head_sha!==intent.base || run.head_branch!==intent.defaultBranch || Number(run.run_attempt??1)!==1 || run.path!==`.github/workflows/${intent.workflow}` || run.repository?.full_name!==api.repository)return {status:'ignored'};
 const recognized=await runs(api,id);if(recognized.length!==1||recognized[0].id!==run.id)return {status:'ignored'};
 const type=intent.stage==='fix'&&run.conclusion==='success'?'generated':'completed';
 await appendEvent(api,{id:`run-${run.id}`,type,commandId:id,runId:run.id,conclusion:run.conclusion,url:run.html_url},{expectedHead:state.head});return {status:'recorded',type};
}
export async function routeCommand(api,event) {
 if(!['created','edited'].includes(event.action)||!event.comment||!event.issue)return {status:'ignored'};
 const comment=event.comment;const command=parseCommand(comment.body);
 if(!command || (event.action==='edited'&&!['pause','revoke'].includes(command.kind)))return {status:'ignored'};
 const reply=async(status,message)=>{await api.post(`${api.root}/issues/${event.issue.number}/comments`,{body:`Heal: ${message}`});return {status};};
 try {
 if(comment.created_at!==comment.updated_at&&!['pause','revoke'].includes(command.kind))throw new Error('Edited commands are not accepted');
 const config=await api.configuration();validatePolicy(config.policy);
 if(!allowed(config.policy,comment.user))throw new Error('Only configured human maintainers or administrators may issue commands');
 let issue=event.issue.number,testPr,revisionPr;
 if(event.issue.pull_request){try{issue=await issueForTest(api,issue);}catch{issue=await issueForTest(api,await testForFix(api,issue));}}
 if(['fix','revise-tests'].includes(command.kind)){testPr=command.target;if(await issueForTest(api,testPr)!==issue)throw new Error('PR belongs to another issue');}
 if(command.kind==='revise-fix'){revisionPr=command.target;testPr=await testForFix(api,revisionPr);if(await issueForTest(api,testPr)!==issue)throw new Error('Fix belongs to another issue');}
 if(command.kind==='revise-tests')revisionPr=testPr;
 let state=await readState(api);const commandId=String(comment.id);
 const controlId=event.action==='edited'?"edit-"+commandId+'-'+digest(comment.body+'|'+comment.updated_at):"control-"+commandId;
 if(event.action==='edited'?state.events.some(e=>e.id===controlId):state.events.some(e=>e.commandId===commandId))return {status:'duplicate'};
 if(['accept','pause','revoke','resume'].includes(command.kind)){
 if(command.policy && command.policy!==digest(JSON.stringify(config.policy)))throw new Error('Policy fingerprint is stale');
 if(command.kind==='accept'&&command.scope!==digest((await api.get(`${api.root}/issues/${issue}`)).body??''))throw new Error('Scope fingerprint is stale');
 await appendEvent(api,{id:controlId,type:'control',commandId,issue,comment},{expectedHead:state.head});
 if(['pause','revoke'].includes(command.kind)) {
   for(const intent of state.events.filter(e=>e.type==='intent'&&e.issue===issue)) {
     try {for(const run of await runs(api,intent.commandId))if(run.status!=='completed'&&run.path===`.github/workflows/${intent.workflow}`)await api.request(`${api.root}/actions/runs/${run.id}/cancel`,'POST');} catch { /* The durable control still blocks publication when cancellation is unavailable. */ }
   }
 }
 return reply('recorded',`${command.kind} recorded for issue #${issue}.`);
 }
 if(!config.policy.enabled)throw new Error('Healing is disabled');
 const c=await api.scope(issue);c.comments=[...controlComments(state,issue),...c.comments.filter(x=>!controlComments(state,issue).some(y=>y.id===x.id) || ['/heal pause','/heal revoke'].includes(x.body.trim()))];
 if(command.kind!=='discuss')authorizeScope(c);
 else {let paused=0;for(const x of c.comments.sort((a,b)=>a.id-b.id)){if(!allowed(c.policy,x.user))continue;const rank=c.policy.roles.administrators.includes(x.user.id)?2:1;if(x.body.trim()==='/heal pause')paused=Math.max(paused,rank);if(x.body.trim()===`/heal resume ${digest(JSON.stringify(c.policy))}`&&rank>=paused&&x.created_at===x.updated_at)paused=0;}if(paused)throw new Error('Healing is paused');}
 if(stage(command.kind)==='fix')await api.context(testPr);
 if(command.kind==='tests') {
   const prior=await api.list(`${api.root}/pulls?state=all`);
   if(prior.some(p=>{try{const m=parseProposal(p.body??'');return m.issue===issue&&m.scope===c.scope;}catch{return false;}}))throw new Error('A test proposal already exists for this scope; use /heal revise-tests NUMBER to preserve its review history');
 }
 const intents=state.events.filter(e=>e.type==='intent'&&e.issue===issue);
 const limit=config.policy.limits?.maxAttempts??10;if(!Number.isSafeInteger(limit)||limit<1||intents.length>=limit)throw new Error('Per-issue command limit exhausted');
 for(const intent of intents.filter(e=>e.stage===stage(command.kind))){if(state.events.some(e=>e.type==='completed'&&e.commandId===intent.commandId))continue;const found=await runs(api,intent.commandId);if(found.length===1&&found[0].status==='completed'){const recorded=await recordRun(api,{action:'completed',workflow_run:found[0]});if(recorded.status!=='recorded'||recorded.type!=='completed')throw new Error('Unrecognized completed run');state=await readState(api);}else throw new Error('An active or uncertain command already occupies this stage');}
 const inputs={command_id:commandId,...(stage(command.kind)==='fix'?{test_pr:String(testPr)}:{issue:String(issue)}),...(revisionPr?{revision_pr:String(revisionPr)}:{})};
 await appendEvent(api,{id:`intent-${commandId}`,type:'intent',commandId,issue,testPr,revisionPr,kind:command.kind,stage:stage(command.kind),base:config.base,defaultBranch:config.defaultBranch,scope:digest(c.issue.body??''),policyDigest:digest(JSON.stringify(config.policy)),comment,commentIssue:event.issue.number,workflow:workflows[stage(command.kind)],inputs},{expectedHead:state.head});
 await api.request(`${api.root}/actions/workflows/${workflows[stage(command.kind)]}/dispatches`,'POST',{ref:config.defaultBranch,inputs});
 return reply('dispatched',`${command.kind} requested for issue #${issue} (command #${commandId}). [Actions](https://github.com/${api.repository}/actions).`);
 }catch(e){return reply('rejected',`${e.message}. No automatic retry; an uncertain dispatch remains reserved.`);}
}
export async function validateCommandAuthorization(api,{commandId,kind,issue,testPr,revisionPr}) {
 if(!/^[1-9][0-9]*$/.test(String(commandId??'')))throw new Error('An explicit command ID is required');
 const state=await readState(api);const intent=state.events.find(e=>e.type==='intent'&&e.commandId===String(commandId));
 if(!intent||intent.stage!==stage(kind)|| (issue && intent.issue!==Number(issue)) || (testPr&&intent.testPr!==Number(testPr)) || String(intent.revisionPr??'')!==String(revisionPr??''))throw new Error('Dispatch does not match a durable command');
 const config=await api.configuration();validatePolicy(config.policy);if(!config.policy.enabled||!allowed(config.policy,intent.comment.user))throw new Error('Command actor is no longer authorized');
 const live=await api.get(`${api.root}/issues/comments/${commandId}`);
 if(live.body!==intent.comment.body||live.user?.id!==intent.comment.user.id||live.user?.type!=='User'||live.created_at!==live.updated_at)throw new Error('Original command changed or was deleted');
 const c=await api.scope(intent.issue);
 if(c.base!==intent.base || digest(c.issue.body??'')!==intent.scope || digest(JSON.stringify(c.policy))!==intent.policyDigest)throw new Error('Command scope, policy, or base changed');
 const originals=controlComments(state,intent.issue);
 c.comments=[...originals,...c.comments.filter(x=>!originals.some(y=>y.id===x.id) || ['/heal pause','/heal revoke'].includes(x.body.trim()))];
 if(intent.stage!=='discuss')authorizeScope(c);
 else {
   let paused=0;
   for(const x of c.comments.sort((a,b)=>a.id-b.id)) {
     if(!allowed(c.policy,x.user))continue;
     const level=c.policy.roles.administrators.includes(x.user.id)?2:1;
     if(x.body.trim()==='/heal pause')paused=Math.max(paused,level);
     if(x.body.trim()===`/heal resume ${digest(JSON.stringify(c.policy))}`&&level>=paused&&x.created_at===x.updated_at)paused=0;
   }
   if(paused)throw new Error('Healing is paused');
 }
 if(intent.stage==='fix')await api.context(intent.testPr);
 return intent;
}
export async function validateDispatch(api,args) {
 const intent=await validateCommandAuthorization(api,args);
 const currentState=await readState(api);
 if(currentState.events.some(e=>['completed','generated'].includes(e.type)&&e.commandId===String(args.commandId)))throw new Error('Command has already run');
 const commandId=String(args.commandId);
 const config=await api.configuration();
 if(config.base!==process.env.GITHUB_SHA || config.base!==intent.base)throw new Error('Dispatch source is not the current authorized base');
 const found=await runs(api,commandId);if(found.length!==1||found[0].path!==`.github/workflows/${intent.workflow}`||found[0].head_branch!==config.defaultBranch||String(found[0].id)!==process.env.GITHUB_RUN_ID||String(process.env.GITHUB_RUN_ATTEMPT??'1')!=='1')throw new Error('Duplicate or unrecognized dispatch run');
 return intent;
}







