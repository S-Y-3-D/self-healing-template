import {createPublicKey,createPrivateKey,sign,verify} from 'node:crypto';
const refPath=api=>`${api.root}/git/ref/heads/heal-state`;
const missing=e=>e.status===404 || /\(404\)/.test(e.message);
const signedBytes=data=>Buffer.from(JSON.stringify({version:1,events:data.events,parent:data.parent}));
async function publicKey(api) {
 const pem=(await api.configuration()).policy.statePublicKey;
 try {const key=createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw new Error();return key;}
 catch {throw new Error('Configure a valid Ed25519 state public key on the default branch');}
}
function validSignature(data,key) {
 return typeof data.signature==='string' && /^[A-Za-z0-9+/]{86}==$/.test(data.signature) && verify(null,signedBytes(data),key,Buffer.from(data.signature,'base64'));
}
export async function readState(api) {
 const key=api.enforceStateSignature?await publicKey(api):null;
 let ref;try {ref=await api.get(refPath(api));} catch(e){if(missing(e)) return {head:null,events:[]};throw e;}
 const file=await api.get(`${api.root}/contents/state.json?ref=${ref.object.sha}`);
 const data=JSON.parse(Buffer.from(file.content,'base64').toString('utf8'));
 if(data.version!==1 || !Array.isArray(data.events)) throw new Error('Invalid durable healing state');
 if(key) {
  if(!validSignature(data,key))throw new Error('Invalid durable state signature');
  const commit=await api.get(`${api.root}/git/commits/${ref.object.sha}`);
  if(!Array.isArray(commit.parents)||commit.parents.length>1||data.parent!==(commit.parents[0]?.sha??null))throw new Error('Signed state parent does not match its Git commit');
 }
 return {head:ref.object.sha,events:data.events};
}
export function controlComments(state,issue) {return state.events.filter(e=>e.type==='control' && e.issue===Number(issue)).map(e=>e.comment);}
export async function appendEvent(api,event,options={}) {
 const current=await readState(api);
 if(Object.hasOwn(options,'expectedHead') && current.head!==options.expectedHead) throw new Error('Healing state changed; post a fresh command');
 if(!event.id || current.events.some(e=>e.id===event.id)) throw new Error('Duplicate state event');
 const events=[...current.events,JSON.parse(JSON.stringify(event))];
 const envelope={version:1,events,parent:current.head};
 if(api.enforceStateSignature) {
  const key=await publicKey(api);
  try {
   const privateKey=createPrivateKey(process.env.HEAL_STATE_PRIVATE_KEY??'');
   if(privateKey.asymmetricKeyType!=='ed25519')throw new Error();
   envelope.signature=sign(null,signedBytes(envelope),privateKey).toString('base64');
  } catch {throw new Error('A valid Ed25519 state signing key is required');}
  if(!validSignature(envelope,key))throw new Error('State signing key does not match the anchored public key signature');
 }
 const files=[['state.json',envelope],[`events/${event.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`,event]];
 const entries=[];
 for(const [path,data] of files){const blob=await api.post(`${api.root}/git/blobs`,{encoding:'utf-8',content:JSON.stringify(data,null,2)+'\n'});entries.push({path,mode:'100644',type:'blob',sha:blob.sha});}
 const parent=current.head?await api.get(`${api.root}/git/commits/${current.head}`):null;
 const tree=await api.post(`${api.root}/git/trees`,{...(parent?{base_tree:parent.tree.sha}:{}),tree:entries});
 const commit=await api.post(`${api.root}/git/commits`,{message:`heal state: ${event.id}`,tree:tree.sha,parents:current.head?[current.head]:[]});
 if(current.head) await api.request(`${api.root}/git/refs/heads/heal-state`,'PATCH',{sha:commit.sha,force:false});
 else await api.post(`${api.root}/git/refs`,{ref:'refs/heads/heal-state',sha:commit.sha});
 return {head:commit.sha,events};
}
