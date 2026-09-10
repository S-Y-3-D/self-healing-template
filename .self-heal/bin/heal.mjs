import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GitHub, authorizeScope, publish, positive } from '../lib/github.mjs';
import { digest, validatePolicy } from '../lib/policy.mjs';
import { verify, verifyTests } from '../lib/verification.mjs';
import { refreshGates } from '../lib/published.mjs';
import { routeCommand,validateDispatch,validateCommandAuthorization,parseCommand } from '../lib/commands.mjs';
import { discussionContext,testRevisionContext } from '../lib/conversation.mjs';
import { auditSetup } from '../lib/setup.mjs';
import { finishDiscussion } from '../lib/lifecycle.mjs';
import { createFailureFeedback,loadFailureFeedback } from '../lib/feedback.mjs';
import { readState } from '../lib/state.mjs';

const [command,arg]=process.argv.slice(2);
const out=resolve(process.env.HEAL_OUTPUT??'.heal-output');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(name,data)=>{await mkdir(out,{recursive:true});await writeFile(join(out,name),JSON.stringify(data,null,2)+'\n');};
const api=()=>new GitHub(process.env.GITHUB_REPOSITORY,process.env.GH_TOKEN??process.env.GITHUB_TOKEN);
try {
  if(command==='doctor') {
    const p=validatePolicy(await read('.self-heal/policy.json'));
    console.log(JSON.stringify({policy:'valid',enabled:p.enabled,node:process.version,adapter:'node:test (.test.mjs), standard library only',next:'Configure protections and AI credentials before enabling HEAL_ENABLED.'},null,2));
  } else if(command==='scope') {
    const c=await api().scope(positive(arg));
    console.log(`Issue #${c.issue.number}\nApprove by posting a new comment:\n/heal accept ${c.scope} ${digest(JSON.stringify(c.policy))}`);
  } else if(command==='route') {
    const event=await read(process.env.GITHUB_EVENT_PATH);const kind=parseCommand(event.comment?.body)?.kind;
    if(process.env.HEAL_ENABLED!=='true' && !['pause','revoke','resume','accept'].includes(kind)) {
      if(kind)await api().post(`${api().root}/issues/${event.issue.number}/comments`,{body:'Heal: AI is disabled. Complete setup and enable HEAL_ENABLED before requesting an AI run.'});
    } else console.log(JSON.stringify(await routeCommand(api(),event)));
  } else if(command==='complete') {
    await finishDiscussion(api(),await read(process.env.GITHUB_EVENT_PATH));
  } else if(command==='setup') {
    const result=await auditSetup(api());console.log(JSON.stringify(result,null,2));
    if(!result.ready)process.exitCode=1;
  } else if(command==='discussion-context'||command==='test-context') {
    const gh=api();const issue=positive(process.env.HEAL_ISSUE??arg);
    const commandId=process.env.HEAL_COMMAND_ID;
    const revisionPr=process.env.HEAL_REVISION_PR||undefined;
    await validateDispatch(gh,{commandId,kind:command==='discussion-context'?'discuss':'tests',issue,revisionPr});
    const c=revisionPr ? await testRevisionContext(gh,issue,positive(revisionPr)) : await discussionContext(gh,issue);
    if(command==='test-context')authorizeScope(c);
    await save('context.json',{...c,commandId,revisionPr:revisionPr?positive(revisionPr):undefined,testPaths:c.policy.testPaths});
  } else if(command==='preflight') {
    const gh=api();const testPr=positive(process.env.HEAL_TEST_PR??arg);
    const revisionPr=process.env.HEAL_REVISION_PR||undefined;
    await validateDispatch(gh,{commandId:process.env.HEAL_COMMAND_ID,kind:'fix',testPr,revisionPr});
    const c=await gh.context(testPr);
    const [baseFiles,testFiles]=await Promise.all([api().snapshot(c.base),api().snapshot(c.authorization.testHead)]);
    await verifyTests({policy:c.policy,baseFiles,testFiles},{sandbox:'docker'});
    const conversation=await discussionContext(gh,c.issue.number,{revisionPr:revisionPr?positive(revisionPr):testPr});
    const previousFailure=await loadFailureFeedback(gh,c.authorization);
    await save('authorization.json',c.authorization);
    const modelTests=Object.fromEntries(Object.entries(testFiles).filter(([path])=>c.policy.testPaths.some(prefix=>path.startsWith(prefix))));
    const modelContext={issue:c.issue,authorization:c.authorization,policy:c.policy,testFiles:modelTests,conversation,previousFailure};
    if(JSON.stringify(modelContext).length>150000)throw new Error('Combined tests/conversation/feedback exceeds 150000 characters; split the work before requesting AI');
    await save('context.json',modelContext);
  } else if(command==='prepare') {
    const candidate=await read(resolve(arg));
    // The number is supplied from a trusted workflow input, never inferred from model output.
    const p=await api().payload(positive(process.env.HEAL_TEST_PR),candidate);
    await save('payload.json',p);
  } else if(command==='verify') {
    const payload=await read(resolve(arg));
    try {await save('verified.json',await verify(payload,{sandbox:'docker'}));}
    catch(error){await save('failure.json',createFailureFeedback(error,payload));throw error;}
  } else if(command==='publish') {
    if(process.env.HEAL_ENABLED!=='true')throw new Error('Healing is disabled');
    const event=await read(process.env.GITHUB_EVENT_PATH);
    const match=event.workflow_run?.display_title?.match(/^Heal implementation test PR #(\d+) command #(\d+)$/);
    if(!match)throw new Error('Missing explicit fix provenance');
    const intent=(await readState(api())).events.find(e=>e.type==='intent'&&e.commandId===match[2]);
    await validateCommandAuthorization(api(),{commandId:match[2],kind:'fix',testPr:match[1],revisionPr:intent?.revisionPr});
    const result=await publish(api(),await read(resolve(arg)),process.env.GITHUB_RUN_ID);
    await save('publication.json',{url:result.html_url,number:result.number});console.log(result.html_url);
  } else if(command==='gate') {
    await refreshGates(api());
  } else if(command==='source-run') {
    const event=await read(process.env.GITHUB_EVENT_PATH);const run=event.workflow_run;
    const gh=api();const config=await gh.configuration();
    if(run.repository?.full_name!==gh.repository || run.event!=='workflow_dispatch' || run.head_branch!==config.defaultBranch || run.path!=='.github/workflows/heal-implement.lock.yml' || run.conclusion!=='success' || run.head_sha!==config.base) throw new Error('Untrusted, unsuccessful or stale generator run');
    const match=run.display_title?.match(/^Heal implementation test PR #(\d+) command #(\d+)$/);
    if(!match) throw new Error('Generator run has no authoritative test PR number');
    const intent=(await readState(gh)).events.find(e=>e.type==='intent'&&e.commandId===match[2]);
    if(!intent||intent.stage!=='fix'||intent.testPr!==positive(match[1])||intent.base!==run.head_sha||run.run_attempt!==1) throw new Error('Generator is not bound to an explicit fix command');
    await api().context(positive(match[1]));
    await writeFile(process.env.GITHUB_OUTPUT,`test_pr=${match[1]}\n`,{flag:'a'});
  } else {
    throw new Error('Commands: doctor | scope ISSUE | test-context ISSUE | preflight TEST_PR | prepare CANDIDATE | verify PAYLOAD | publish EVIDENCE | source-run');
  }
} catch(error) {console.error(`heal: ${error.message}`);process.exitCode=1;}
