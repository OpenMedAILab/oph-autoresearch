import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { canonicalJson, sha256 } from './skill-lock.ts'

type Kind = 'study' | 'manuscript' | 'skillcandidate'
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export async function writeResearchDocument(input:{store:Store;workspaceRoot:string;campaignId:string;expectedVersion:number;idempotencyKey:string;kind:Kind;document:Record<string,unknown>}) {
 if(!ID.test(input.campaignId)||!ID.test(input.idempotencyKey))throw new Error('invalid document identity')
 const campaign=getResearchCampaign(input.store,input.campaignId);if(!campaign)throw new Error('campaign not found')
 const keys=(x:Record<string,unknown>)=>Object.keys(x).sort().join(',')
 if(input.kind==='study'&&keys(input.document)!=='PICO,codeVersion,counterEvidence,endpoints,evidenceCitations,previousVersion,protocol,question,splitPlan')throw new Error('invalid study document')
 if(input.kind==='study'&&(typeof input.document.question!=='string'||typeof input.document.codeVersion!=='string'||!Array.isArray(input.document.evidenceCitations)||!Array.isArray(input.document.counterEvidence)||!Array.isArray(input.document.endpoints)||input.document.previousVersion!==null&&typeof input.document.previousVersion!=='string'))throw new Error('invalid study document')
 if(input.kind==='manuscript'&&(!Array.isArray(input.document.claims)||typeof input.document.text!=='string'||!/^sha256:[a-f0-9]{64}$/.test(String(input.document.journalRequirementsHash))))throw new Error('invalid manuscript document')
 if(input.kind==='manuscript')for(const claim of input.document.claims as unknown[]){if(!claim||typeof claim!=='object'||!Array.isArray((claim as Record<string,unknown>).artifactVersionIds)||typeof (claim as Record<string,unknown>).reviewId!=='string')throw new Error('unsupported manuscript claim');for(const ref of (claim as {artifactVersionIds:unknown[]}).artifactVersionIds)if(typeof ref!=='string'||!campaign.artifactVersions.some(a=>a.id===ref))throw new Error('unsupported manuscript claim')}
 if(input.kind==='skillcandidate'&&(input.document.status!=='candidate-not-admitted'||!/^sha256:[a-f0-9]{64}$/.test(String(input.document.sourceHash))||!Array.isArray(input.document.evaluationArtifactVersionIds)))throw new Error('invalid skill candidate')
 const bytes=Buffer.from(`${canonicalJson({kind:input.kind,document:input.document})}\n`);if(bytes.length>262144)throw new Error('document exceeds size limit');const hash=sha256(bytes),root=await realpath(resolve(input.workspaceRoot));let dir=root;for(const part of ['.oph','research',input.campaignId,'documents']){const next=join(dir,part);const stat=await lstat(next).catch((e:NodeJS.ErrnoException)=>e.code==='ENOENT'?null:Promise.reject(e));if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()))throw new Error('unsafe document path');if(!stat)await mkdir(next);dir=await realpath(next)}const name=`${input.kind}-${hash.slice(-16)}.json`,path=join(dir,name);await writeFile(path,bytes,{flag:'wx'}).catch(async e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=await readFile(path);if(!old.equals(bytes))throw e})
 const changed=mutateResearchCampaign(input.store,input.campaignId,{expectedVersion:input.expectedVersion,idempotencyKey:input.idempotencyKey,command:{kind:'recordArtifact',artifactId:`document-${input.kind}`,artifactKind:`research-document-${input.kind}`,contentHash:hash,uri:pathToFileURL(path).href}})
 if(!changed.ok)throw new Error(changed.message)
 return {campaign:changed.campaign,contentHash:hash,uri:pathToFileURL(path).href}
}
export function listResearchDocuments(store:Store,campaignId:string){const c=getResearchCampaign(store,campaignId);if(!c)throw new Error('campaign not found');return c.artifactVersions.filter(a=>a.kind.startsWith('research-document-'))}
