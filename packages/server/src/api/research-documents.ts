import { getResearchCampaign, type Store } from '@oph-autoresearch/store'
import { listResearchDocuments, writeResearchDocument } from '../research/research-documents.ts'

/** Standalone route for wiring by the main research API. */
export async function handleResearchDocumentsApi(input:{store:Store;workspaceId:string;workspaceRoot:string;url:URL;request:Request}) {
 const m=/^\/api\/research\/campaigns\/([A-Za-z0-9_-]+)\/documents$/.exec(input.url.pathname);if(!m)return null
 const campaign=getResearchCampaign(input.store,m[1]!);if(!campaign||campaign.workspaceId!==input.workspaceId)return Response.json({error:'not_found'},{status:404})
 if(input.request.method==='GET')return Response.json({documents:listResearchDocuments(input.store,campaign.id)})
 if(input.request.method!=='POST')return new Response('',{status:405})
 const body=await input.request.json().catch(()=>null) as {expectedVersion?:unknown;idempotencyKey?:unknown;kind?:unknown;document?:unknown}|null
 if(!body||typeof body.expectedVersion!=='number'||typeof body.idempotencyKey!=='string'||!['study','manuscript','skillcandidate'].includes(String(body.kind))||!body.document||typeof body.document!=='object'||Array.isArray(body.document))return Response.json({error:'invalid_document'},{status:400})
 try{return Response.json(await writeResearchDocument({store:input.store,workspaceRoot:input.workspaceRoot,campaignId:campaign.id,expectedVersion:body.expectedVersion,idempotencyKey:body.idempotencyKey,kind:body.kind as 'study'|'manuscript'|'skillcandidate',document:body.document as Record<string,unknown>}))}catch(error){return Response.json({error:error instanceof Error?error.message:'document_write_failed'},{status:409})}
}
