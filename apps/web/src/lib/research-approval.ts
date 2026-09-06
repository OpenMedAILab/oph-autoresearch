/** The application receives a bound signature, never the independent signer's session or key. */
export async function requestHumanApproval(
  approvalUrl: string,
  request: {
    workspaceId: string
    campaignId: string
    action: 'approve' | 'revoke'
    body: unknown
    display?: { title: string; task: string; revision: number }
  },
  popup: Window,
): Promise<string> {
  const target = new URL(approvalUrl)
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error('审批渠道地址无效')
  const origin = target.origin
  target.hash = new URLSearchParams({
    request: JSON.stringify(request),
    replyOrigin: window.location.origin,
  }).toString()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(closed)
      window.removeEventListener('message', receive)
    }
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== origin ||
        event.source !== popup ||
        event.data?.type !== 'oph-human-approval' ||
        typeof event.data.proof !== 'string'
      )
        return
      cleanup()
      resolve(event.data.proof)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('审批等待超时，请重新发起'))
    }, 240_000)
    const closed = setInterval(() => {
      if (popup.closed) {
        cleanup()
        reject(new Error('审批窗口已关闭'))
      }
    }, 500)
    window.addEventListener('message', receive)
    popup.location.href = target.href
  })
}
