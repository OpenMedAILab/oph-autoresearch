import { type KeyObject, randomBytes, sign } from 'node:crypto'
import { canonicalJson, sha256 } from './skill-lock.ts'

export interface HumanApprovalRequest {
  display?: { title: string; task: string; revision: number }
  workspaceId: string
  campaignId: string
  action: 'approve' | 'revoke' | 'labelset'
  body: Record<string, unknown>
}

/** Independent developer approval console. Its session credential is never an application bearer. */
export function createHumanApprover(config: {
  issuer: string
  reviewerId: string
  privateKey: KeyObject
  port?: number
}) {
  const token = randomBytes(32).toString('base64url')
  let origin = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = {
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      }
      if (request.headers.get('host') !== new URL(origin).host)
        return new Response('Invalid host', { status: 403, headers })
      if (request.method === 'GET' && url.pathname === '/')
        return new Response(approvalPage, {
          headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
        })
      const sessionCookie = request.headers
        .get('cookie')
        ?.split(';')
        .some((part) => part.trim() === `oph_approval=${token}`)
      if (
        request.method === 'POST' &&
        url.pathname === '/session' &&
        request.headers.get('origin') === origin &&
        request.headers.get('authorization') === `Bearer ${token}`
      )
        return new Response(null, {
          status: 204,
          headers: {
            ...headers,
            'set-cookie': `oph_approval=${token}; HttpOnly; SameSite=Strict; Path=/`,
          },
        })
      if (request.method === 'GET' && url.pathname === '/session')
        return new Response(null, { status: sessionCookie ? 204 : 403, headers })
      if (request.method !== 'POST' || url.pathname !== '/sign')
        return new Response('Not found', { status: 404, headers })
      if (
        request.headers.get('origin') !== origin ||
        !sessionCookie ||
        request.headers.get('content-type') !== 'application/json'
      )
        return new Response('Independent approval session required', { status: 403, headers })
      const text = await request.text()
      if (text.length > 65536) return new Response('Too large', { status: 413, headers })
      try {
        const input = JSON.parse(text) as HumanApprovalRequest
        if (
          !input ||
          Object.keys(input).sort().join(',') !==
            (input.display === undefined
              ? 'action,body,campaignId,workspaceId'
              : 'action,body,campaignId,display,workspaceId') ||
          (input.display !== undefined &&
            (!input.display ||
              Object.keys(input.display).sort().join(',') !== 'revision,task,title' ||
              typeof input.display.title !== 'string' ||
              input.display.title.length > 500 ||
              typeof input.display.task !== 'string' ||
              input.display.task.length > 500 ||
              !Number.isSafeInteger(input.display.revision) ||
              input.display.revision < 1)) ||
          !['approve', 'revoke', 'labelset'].includes(input.action) ||
          !/^[\w-]{1,128}$/.test(input.workspaceId) ||
          !/^[\w-]{1,128}$/.test(input.campaignId) ||
          !input.body ||
          typeof input.body !== 'object' ||
          Array.isArray(input.body)
        )
          throw new Error('Invalid request')
        const now = Date.now()
        const claims = {
          issuer: config.issuer,
          reviewerId: config.reviewerId,
          proofId: crypto.randomUUID(),
          issuedAt: now,
          expiresAt: now + 120_000,
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          action: input.action,
          bodyHash: sha256(canonicalJson(input.body)),
        }
        const encoded = Buffer.from(canonicalJson(claims)).toString('base64url')
        const signature = sign(null, Buffer.from(encoded), config.privateKey).toString('base64url')
        return Response.json({ proof: `v1.${encoded}.${signature}` }, { headers })
      } catch {
        return new Response('Invalid approval request', { status: 400, headers })
      }
    },
  })
  origin = `http://localhost:${server.port}`
  return { origin, sessionUrl: `${origin}/#session=${token}`, close: () => server.stop(true) }
}

const approvalPage = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>研究审批确认</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;padding:20px;color:#16343a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f5;padding:20px}button{padding:12px 24px;margin-right:12px}#status{color:#8a342a}</style><h1>独立研究审批</h1><p>逐项核对研究项目、冻结版本、执行任务、预算、设备和产物。此页面只签署下面这一份请求。</p><div id="summary">请从研究项目发起审批。</div><details><summary>高级：查看签署正文</summary><pre id="request"></pre></details><button id="confirm" disabled>确认并签署</button><button id="cancel">取消</button><p id="status"></p><script>
const params=new URLSearchParams(location.hash.slice(1));
const initialized=params.get('session')?fetch('/session',{method:'POST',headers:{authorization:'Bearer '+params.get('session')}}).then(response=>{history.replaceState(null,'',location.pathname);return response.ok;}):fetch('/session').then(response=>response.ok);
let request,replyOrigin;
try{request=JSON.parse(params.get('request'));replyOrigin=params.get('replyOrigin');if(!request||!/^https?:/.test(replyOrigin))throw Error();document.getElementById('request').textContent=JSON.stringify(request,null,2);const scope=request.body.scope||{},limits=scope.executionLimits||{},rows=[['研究项目',request.display?.title||'当前研究项目'],['任务',request.display?.task||'当前冻结任务'],['修订',request.display?.revision||request.body.expectedVersion],['审批类型',({execution:'实验执行',model_review:'独立复核',protocol:'研究方案',release:'结论发布'})[scope.kind]||request.action],['预算',(scope.maxCost??'未提供')+' '+(scope.currency||'')],['最长运行',limits.maxRuntimeMs?limits.maxRuntimeMs/60000+' 分钟':'按已批准方案'],['计算资源',limits.cpu?limits.cpu+' CPU / '+limits.memoryMb+' MB':'按已批准方案'],['关联产物',(scope.artifactVersionIds||[]).length+' 项']];document.getElementById('summary').textContent='';for(const [label,value] of rows){const p=document.createElement('p');p.textContent=label+'：'+value;document.getElementById('summary').appendChild(p);}}catch{}
initialized.then(ready=>{document.getElementById('confirm').disabled=!ready||!request;if(!ready)document.getElementById('status').textContent='请先在此浏览器打开独立审批器启动时提供的会话链接。应用登录令牌无法代替审批会话。';else if(!request)document.getElementById('status').textContent='独立审批会话已建立。请返回研究项目发起审批。';});
document.getElementById('cancel').onclick=()=>window.close();
document.getElementById('confirm').onclick=async()=>{const button=document.getElementById('confirm');button.disabled=true;try{const response=await fetch('/sign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});if(!response.ok)throw Error('签署失败');const result=await response.json();if(!window.opener)throw Error('原研究页面已关闭');window.opener.postMessage({type:'oph-human-approval',proof:result.proof},replyOrigin);document.getElementById('status').textContent='本次请求已签署，请返回研究项目。';}catch(error){document.getElementById('status').textContent=error.message;button.disabled=false;}};
</script></html>`
