const parentDir = (path: string) => path.split('/').slice(0, -1).join('/')

/**
 * 浏览器拖放只负责提供目标目录，真正的边界检查还会在服务端再做一遍。
 * 这里提前挡住明显无效的落点，避免先画出可投放高亮、松手后才报错。
 */
export function dropMoveIssue(
  node: { kind: 'file' | 'dir'; path: string },
  destination: string,
): string | null {
  if (parentDir(node.path) === destination) return '文件已经在这个文件夹中'
  if (
    node.kind === 'dir' &&
    (destination === node.path || destination.startsWith(`${node.path}/`))
  ) {
    return '不能把文件夹移动到它自己里面'
  }
  return null
}
