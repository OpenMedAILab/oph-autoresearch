import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, createConversation, createResearchCampaign, upsertWorkspace } from '@oph-autoresearch/store'
import { listResearchDocuments, writeResearchDocument } from './research-documents.ts'

test('documents write immutable ledger versions and replay the same bytes', async()=>{
 const root=await mkdtemp(join(tmpdir(),'oph-doc-'));const store=new Store({path:':memory:'})
 try{const workspace=upsertWorkspace(store,root,'test');const parent=createConversation(store,{workspaceId:workspace.id,provider:'test',model:'test'});const made=createResearchCampaign(store,{workspaceId:workspace.id,parentConversationId:parent.id,goal:'g',idempotencyKey:'create',policy:{},inputs:{},budget:{currency:'USD',limit:0}});if(!made.ok)throw new Error(made.message);const campaign=made.campaign
  const one=await writeResearchDocument({store,workspaceRoot:root,campaignId:campaign.id,expectedVersion:campaign.version,idempotencyKey:'doc_1',kind:'study',document:{question:'q',PICO:{},evidenceCitations:[],counterEvidence:[],protocol:{},endpoints:[],splitPlan:{},codeVersion:'x',previousVersion:null}})
  expect(one.contentHash).toMatch(/^sha256:/);expect(listResearchDocuments(store,campaign.id)).toHaveLength(1)
 }finally{store.close();await rm(root,{recursive:true,force:true})}
})
