import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getResearchCampaign, mutateResearchCampaign, type Store } from '@oph-autoresearch/store'
import { canonicalJson, sha256 } from './skill-lock.ts'

type Kind = 'study' | 'manuscript' | 'skillcandidate'
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export async function writeResearchDocument(input:{store:Store;workspaceRoot:string;campaignId:string;expectedVersion:number;idempotencyKey:string;kind:Kind;document:Record<string,unknown>}) {
 if(!ID.test(input.campaignId)||!ID.test(input.idempotencyKey))throw new Error('invalid document identity')
 const campaign=getResearchCampaign(input.store,input.campaignId);if(!campaign)throw new Error('campaign not found')
 if(input.kind==='manuscript'&&!Array.isArray(input.document.claims))throw new Error('manuscript claims require evidence references')
 const bytes=Buffer.from(`${canonicalJson({kind:input.kind,document:input.document})}\n`),hash=sha256(bytes),dir=join(resolve(input.workspaceRoot),'.oph','research',input.campaignId,'documents');await mkdir(dir,{recursive:true});const name=`${input.kind}-${hash.slice(-16)}.json`,path=join(dir,name);await writeFile(path,bytes,{flag:'wx'}).catch(async e=>{if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=await readFile(path);if(!old.equals(bytes))throw e})
 const changed=mutateResearchCampaign(input.store,input.campaignId,{expectedVersion:input.expectedVersion,idempotencyKey:input.idempotencyKey,command:{kind:'recordArtifact',artifactId:`document-${input.kind}`,artifactKind:`research-document-${input.kind}`,contentHash:hash,uri:pathToFileURL(path).href}})
 if(!changed.ok)throw new Error(changed.message)
 return {campaign:changed.campaign,contentHash:hash,uri:pathToFileURL(path).href}
}
export function listResearchDocuments(store:Store,campaignId:string){const c=getResearchCampaign(store,campaignId);if(!c)throw new Error('campaign not found');return c.artifactVersions.filter(a=>a.kind.startsWith('research-document-'))}
