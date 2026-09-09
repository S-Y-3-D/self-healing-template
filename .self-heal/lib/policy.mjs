import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const human = user => user?.type === 'User' && Number.isSafeInteger(user.id);
const member = (policy, role, user) => human(user) && policy.roles[role].includes(user.id);
const rank = (policy, user) => member(policy,'administrators',user) ? 2 : member(policy,'maintainers',user) ? 1 : 0;

export function validatePolicy(p) {
  requireThat(p?.version === 1 && typeof p.enabled === 'boolean', 'Invalid policy version or enabled flag');
  for (const role of ['maintainers','testOwners','administrators']) {
    requireThat(Array.isArray(p.roles?.[role]) && p.roles[role].length > 0 && p.roles[role].every(id => Number.isSafeInteger(id) && id > 0), `Configure ${role} as GitHub numeric user IDs`);
  }
  for (const key of ['implementationPaths','testPaths']) {
    requireThat(Array.isArray(p[key]) && p[key].length > 0 && p[key].every(s => typeof s === 'string' && /^[a-zA-Z0-9_-]+\/$/.test(s)), `Invalid ${key}: use top-level directory prefixes`);
  }
  const forbidden = ['.github/','.self-heal/'];
  requireThat(!p.implementationPaths.some(a => forbidden.includes(a) || p.testPaths.includes(a)), 'Implementation and protected paths overlap');
  requireThat(Number.isSafeInteger(p.maxFiles) && p.maxFiles > 0 && p.maxFiles <= 100, 'Invalid maxFiles');
  requireThat(Number.isSafeInteger(p.maxBytes) && p.maxBytes > 0 && p.maxBytes <= 1000000, 'Invalid maxBytes');
  return p;
}

export function latestReviews(reviews) {
  const latest = new Map();
  for (const review of [...reviews].sort((a,b) => a.id-b.id)) {
    if (['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state)) latest.set(review.user.id, review);
  }
  return latest;
}

export function authorizeScope(c) {
  const p = validatePolicy(c.policy);
  requireThat(p.enabled, 'Healing is disabled');
  requireThat(c.issue.state === 'open', 'Issue must be open');
  const scope = digest(c.issue.body ?? '');
  requireThat(scope === c.scope, 'Issue scope changed');
  let accepted = null;
  let authority = 0;
  let pausedBy = 0;
  for (const comment of [...c.comments].sort((a,b) => a.id-b.id)) {
    const level = rank(p,comment.user);
    if (!level) continue;
    const body = comment.body.trim();
    // Edited approval/resume comments never grant new authority. Denials still count.
    const edited = comment.created_at && comment.updated_at && comment.created_at !== comment.updated_at;
    if (body === '/heal pause') pausedBy = Math.max(pausedBy,level);
    if (body === `/heal resume ${digest(JSON.stringify(p))}` && !edited && level >= pausedBy) pausedBy = 0;
    if (body === '/heal revoke' && level >= authority) { accepted = null; authority = level; }
    if (body === `/heal accept ${scope} ${digest(JSON.stringify(p))}` && !edited && level >= authority) { accepted = comment; authority = level; }
  }
  requireThat(!pausedBy, 'Healing paused by an authorized reviewer');
  requireThat(accepted, 'Missing or revoked scope approval');
  return {scope,scopeApproval:accepted.id};
}

export function authorize(c) {
  const {scope,scopeApproval}=authorizeScope(c);
  const p=c.policy;
  requireThat(c.pr.state === 'open', 'Test proposal must be open');
  requireThat(c.pr.head.repo?.full_name === c.repository && c.pr.base.repo?.full_name === c.repository, 'Test proposal must use this repository');
  requireThat(c.pr.base.sha === c.base, 'Base moved; refresh test proposal and approve again');
  requireThat(c.files.length > 0 && c.files.every(f => ['added','modified'].includes(f.status) && !f.previous_filename && p.testPaths.some(prefix => f.filename.startsWith(prefix))), 'Test-only proposal required; renames/deletions are not accepted');
  const reviews = [...latestReviews(c.reviews).values()].filter(r => member(p,'testOwners',r.user));
  requireThat(!reviews.some(r => r.state === 'CHANGES_REQUESTED'), 'Test review: changes requested');
  const approvals = reviews.filter(r => r.state === 'APPROVED' && r.commit_id === c.pr.head.sha);
  requireThat(approvals.length > 0, 'Missing human review of the exact test revision');
  return { repository:c.repository, issue:c.issue.number, testPr:c.pr.number, scope, base:c.base,
    testHead:c.pr.head.sha, policyDigest:digest(JSON.stringify(p)), scopeApproval,
    testApprovals:approvals.map(r => r.id).sort((a,b)=>a-b) };
}

export function validateCandidate(candidate, policy) {
  validatePolicy(policy);
  requireThat(candidate && Array.isArray(candidate.changes) && candidate.changes.length > 0 && candidate.changes.length <= policy.maxFiles, 'Invalid candidate file count');
  const seen = new Set(); let size = 0;
  for (const change of candidate.changes) {
    const path = change?.path;
    requireThat(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(s => s && s !== '.' && s !== '..' && s !== '.git'), 'Unsafe candidate path');
    requireThat(policy.implementationPaths.some(prefix => path.startsWith(prefix)), `Protected candidate path: ${path}`);
    requireThat(!seen.has(path), 'Duplicate candidate path'); seen.add(path);
    requireThat(change.content === null || typeof change.content === 'string', 'Content must be UTF-8 text or null for deletion');
    size += Buffer.byteLength(change.content ?? '');
  }
  requireThat(size <= policy.maxBytes, 'Candidate too large');
  return candidate.changes;
}

export function sameAuthorization(expected, current) {
  requireThat(JSON.stringify(expected) === JSON.stringify(current), 'Authorization changed; restart with fresh approvals');
}
