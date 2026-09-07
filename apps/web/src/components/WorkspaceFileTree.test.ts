import { describe, expect, test } from 'bun:test'
import { dropMoveIssue } from '../lib/workspace-file-dnd.ts'

describe('文件树拖放移动', () => {
  test('允许把文件拖到另一个目录或工作区根目录', () => {
    expect(dropMoveIssue({ kind: 'file', path: 'src/train.py' }, 'archive')).toBeNull()
    expect(dropMoveIssue({ kind: 'file', path: 'src/train.py' }, '')).toBeNull()
  })

  test('同目录投放不会发起一次无意义的移动', () => {
    expect(dropMoveIssue({ kind: 'file', path: 'src/train.py' }, 'src')).toBe(
      '文件已经在这个文件夹中',
    )
  })

  test('文件夹不能拖到自身或自己的后代目录', () => {
    expect(dropMoveIssue({ kind: 'dir', path: 'src' }, 'src')).toBe('不能把文件夹移动到它自己里面')
    expect(dropMoveIssue({ kind: 'dir', path: 'src' }, 'src/models')).toBe(
      '不能把文件夹移动到它自己里面',
    )
  })
})
