// 冒烟：setRowFlag / rowDisabledState 往返
import { setRowFlag, rowDisabledState } from '../lib/index.js'

const sample = [
  '# comment',
  '- id: mcp-anki',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: anki-mcp',
  '- id: mcp-cheatengine',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: cheatengine',
].join('\n')

const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}

check(rowDisabledState(sample, 'mcp-anki') === null, 'initial anki state null')
let t = setRowFlag(sample, 'mcp-anki', 'disabled', true)
check(rowDisabledState(t, 'mcp-anki') === true, 'after disable anki true')
check(rowDisabledState(t, 'mcp-cheatengine') === null, 'cheatengine untouched')
t = setRowFlag(t, 'mcp-anki', 'disabled', false)
check(rowDisabledState(t, 'mcp-anki') === null, 'after re-enable null')
check(t === sample, 'roundtrip identical')

// CRLF 文件
const crlf = sample.replaceAll('\n', '\r\n')
let c = setRowFlag(crlf, 'mcp-anki', 'disabled', true)
check(rowDisabledState(c, 'mcp-anki') === true, 'crlf disable works')
check(c.includes('\r\n'), 'crlf preserved')
c = setRowFlag(c, 'mcp-anki', 'disabled', false)
check(c === crlf, 'crlf roundtrip identical')
