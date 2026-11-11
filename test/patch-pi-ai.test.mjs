import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const exec = promisify(execFile)
const patch = 'diff --git a/dist/example.js b/dist/example.js\n--- a/dist/example.js\n+++ b/dist/example.js\n@@ -1,3 +1,3 @@\n export function example() {\n-  return "before"\n+  return "after"\n }\n'
const before = 'export function example() {\n  return "before"\n}\n'
const after = 'export function example() {\n  return "after"\n}\n'

for (const patchEol of ['LF', 'CRLF']) {
  for (const sourceEol of ['LF', 'CRLF']) {
    test(`patch loader accepts ${patchEol} patch / ${sourceEol} vendor and is idempotent`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'model-sdk-patch-'))
      try {
        const scripts = join(root, 'scripts')
        const vendor = join(root, 'node_modules/@earendil-works/pi-ai')
        await Promise.all([mkdir(scripts), mkdir(join(root, 'patches')), mkdir(join(vendor, 'dist'), { recursive: true })])
        const script = join(scripts, 'patch-pi-ai.mjs')
        await copyFile(new URL('../scripts/patch-pi-ai.mjs', import.meta.url), script)
        await writeFile(join(vendor, 'package.json'), JSON.stringify({ version: '1.3.0' }))
        await writeFile(join(root, 'patches/pi-ai-1.3.0.patch'), patchEol === 'CRLF' ? patch.replace(/\n/g, '\r\n') : patch)
        const target = join(vendor, 'dist/example.js')
        await writeFile(target, sourceEol === 'CRLF' ? before.replace(/\n/g, '\r\n') : before)
        for (let pass = 0; pass < 2; pass++) {
          const { stdout } = await exec(process.execPath, [script], { cwd: tmpdir(), timeout: 5000 })
          assert.match(stdout, /Verified Harness patch on 1 pi-ai files/)
          assert.equal(await readFile(target, 'utf8'), after)
          const manifest = JSON.parse(await readFile(join(root, 'dist/pi-ai-patch-manifest.json'), 'utf8'))
          assert.equal(manifest.files['dist/example.js'], createHash('sha256').update(after).digest('hex'))
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
