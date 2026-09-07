import { describe, expect, test } from 'bun:test'
import { languageFor, languageName } from './editor.ts'

describe('代码编辑器语言支持', () => {
  test('Python 与 Java 显示正确的语言名称', () => {
    expect(languageName('research/train.py')).toBe('Python')
    expect(languageName('src/main/java/Pipeline.java')).toBe('Java')
  })

  test('Python 与 Java 都能加载语法解析器', async () => {
    expect((await languageFor('analysis.py')).length).toBe(1)
    expect((await languageFor('Pipeline.java')).length).toBe(1)
  })
})
