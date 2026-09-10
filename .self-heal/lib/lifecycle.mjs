import {readState,appendEvent} from './state.mjs';
import {recordRun} from './commands.mjs';
import {scopeProposal} from './conversation.mjs';
import {digest} from './policy.mjs';

export async function finishDiscussion(api,event) {
  if(event.workflow_run?.path==='.github/workflows/heal-publish.yml') return recordPublication(api,event);
  const result=await recordRun(api,event);
  const run=event.workflow_run;
  const commandId=run?.display_title?.match(/ command #(\d+)$/)?.[1];
  if(!commandId)return result;
  const state=await readState(api);
  const intent=state.events.find(e=>e.type==='intent'&&e.commandId===commandId);
  const recorded=state.events.find(e=>e.id===`run-${run.id}`&&e.commandId===commandId);
  if(!intent||!recorded||event.action!=='completed'||run.repository?.full_name!==api.repository||run.path!==`.github/workflows/${intent.workflow}`||run.head_sha!==intent.base||run.head_branch!==intent.defaultBranch||run.run_attempt!==1)return result;
  if(state.events.some(e=>e.id===`notified-${run.id}`))return {status:'duplicate'};
  let body=`[${intent.kind} run](${run.html_url}) finished: **${run.conclusion}**. No automatic retry.`;
  if(intent.stage==='discuss'&&run.conclusion==='success') {
    const c=await api.scope(intent.issue);
    if(c.scope!==intent.scope || digest(JSON.stringify(c.policy))!==intent.policyDigest) body+=' Scope or policy changed during discussion; post `/heal discuss` again before approving.';
    else body+='\n\n'+scopeProposal(c);
  } else if(intent.stage==='tests'&&run.conclusion==='success') {
    const prs=await api.list(`${api.root}/pulls?state=open`);
    const matching=prs.filter(p=>new RegExp(`^Heal-Command: ${commandId}$`,'m').test(p.body??''));
    if(matching.length===1&&!state.events.some(e=>e.id===`proposal-${commandId}`))await appendEvent(api,{id:`proposal-${commandId}`,type:'proposal',commandId,issue:intent.issue,prNumber:matching[0].number,revisionPr:intent.revisionPr});
    body+=matching.length===1 ? `\n\nReview [test PR #${matching[0].number}](${matching[0].html_url}). Red regression tests are expected. If correct, submit an **Approve** review, then post \`/heal fix ${matching[0].number}\`. Do not merge the tests-only PR.` : '\n\nCheck the run outputs for the test proposal or the reason no proposal was made.';
  }
  if(intent.stage==='fix'&&run.conclusion==='success')body=`Candidate generated. [Run](${run.html_url}). Isolated verification and your publication approval are still required; this is not a passing fix yet.`;
  await api.post(`${api.root}/issues/${intent.issue}/comments`,{body});
  await appendEvent(api,{id:`notified-${run.id}`,type:'notified',commandId,runId:run.id});
  return result;
}

export async function recordPublication(api,event) {
  const run=event.workflow_run;
  if(event.action!=='completed'||run?.path!=='.github/workflows/heal-publish.yml'||run.event!=='workflow_run'||run.repository?.full_name!==api.repository||run.run_attempt!==1||!Number.isSafeInteger(run.id)||run.id<1||!['success','failure','cancelled','skipped','timed_out','action_required','stale','neutral'].includes(run.conclusion)) return {status:'ignored'};
  const match=run.display_title?.match(/^Heal publication for Heal implementation test PR #(\d+) command #(\d+)$/);
  if(!match)return {status:'ignored'};
  const state=await readState(api);const id=match[2];
  const intent=state.events.find(e=>e.type==='intent'&&e.commandId===id);
  if(!intent||intent.stage!=='fix'||intent.testPr!==Number(match[1])||run.head_branch!==intent.defaultBranch||run.head_sha!==intent.base) return {status:'ignored'};
  if(state.events.some(e=>e.id===`publication-${run.id}`))return {status:'duplicate'};
  const matches=[];
  for(let page=1;page<=30;page++) {
    const candidates=await api.get(`${api.root}/actions/workflows/heal-publish.yml/runs?event=workflow_run&per_page=100&page=${page}`);
    matches.push(...candidates.workflow_runs.filter(r=>r.display_title===run.display_title));
    if(candidates.workflow_runs.length<100)break;
    if(page===30)throw new Error('Publication history exceeds safe reconciliation limit');
  }
  if(matches.length!==1||matches[0].id!==run.id)throw new Error('Ambiguous publication attempt; refusing to release command');
  await appendEvent(api,{id:`publication-${run.id}`,type:'completed',commandId:id,issue:intent.issue,runId:run.id,conclusion:run.conclusion,stage:'publication',url:run.html_url},{expectedHead:state.head});
  const prs=run.conclusion==='success'?await api.list(`${api.root}/pulls?state=open`):[];
  const fix=prs.find(p=>new RegExp(`^Heal-Run: ${run.id}$`,'m').test(p.body??''));
  await api.post(`${api.root}/issues/${intent.issue}/comments`,{body:`Fix verification/publication: **${run.conclusion}**. [Evidence and logs](${run.html_url}). ${fix?`Review [fix PR #${fix.number}](${fix.html_url}) before merging.`:`No automatic retry. Inspect the logs, then post \`/heal fix ${intent.testPr}\` for another attempt.`}`});
  return {status:'recorded'};
}
