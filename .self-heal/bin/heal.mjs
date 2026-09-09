import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GitHub, authorizeScope, publish, positive } from '../lib/github.mjs';
import { digest, validatePolicy } from '../lib/policy.mjs';
import { verify, verifyTests } from '../lib/verification.mjs';
import { refreshGates } from '../lib/published.mjs';

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
  } else if(command==='test-context') {
    const c=await api().scope(positive(arg));authorizeScope(c);
    await save('context.json',{issue:c.issue,scope:c.scope,base:c.base,testPaths:c.policy.testPaths});
  } else if(command==='preflight') {
    const c=await api().context(positive(arg));
    const [baseFiles,testFiles]=await Promise.all([api().snapshot(c.base),api().snapshot(c.authorization.testHead)]);
    await verifyTests({policy:c.policy,baseFiles,testFiles},{sandbox:'docker'});
    await save('authorization.json',c.authorization);
    await save('context.json',{issue:c.issue,authorization:c.authorization,policy:c.policy,testFiles});
  } else if(command==='prepare') {
    const candidate=await read(resolve(arg));
    // The number is supplied from a trusted workflow input, never inferred from model output.
    const p=await api().payload(positive(process.env.HEAL_TEST_PR),candidate);
    await save('payload.json',p);
  } else if(command==='verify') {
    const evidence=await verify(await read(resolve(arg)),{sandbox:'docker'});
    await save('verified.json',evidence);
  } else if(command==='publish') {
    const result=await publish(api(),await read(resolve(arg)),process.env.GITHUB_RUN_ID);
    await save('publication.json',{url:result.html_url,number:result.number});console.log(result.html_url);
  } else if(command==='gate') {
    await refreshGates(api());
  } else if(command==='source-run') {
    const event=await read(process.env.GITHUB_EVENT_PATH);const run=event.workflow_run;
    const gh=api();const config=await gh.configuration();
    if(run.repository?.full_name!==gh.repository || run.event!=='workflow_dispatch' || run.head_branch!==config.defaultBranch || run.path!=='.github/workflows/heal-implement.lock.yml' || run.conclusion!=='success' || run.head_sha!==config.base) throw new Error('Untrusted, unsuccessful or stale generator run');
    const match=run.display_title?.match(/^Heal implementation test PR #(\d+)$/);
    if(!match) throw new Error('Generator run has no authoritative test PR number');
    await api().context(positive(match[1]));
    await writeFile(process.env.GITHUB_OUTPUT,`test_pr=${match[1]}\n`,{flag:'a'});
  } else {
    throw new Error('Commands: doctor | scope ISSUE | test-context ISSUE | preflight TEST_PR | prepare CANDIDATE | verify PAYLOAD | publish EVIDENCE | source-run');
  }
} catch(error) {console.error(`heal: ${error.message}`);process.exitCode=1;}
