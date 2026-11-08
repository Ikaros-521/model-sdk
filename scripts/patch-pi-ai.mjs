import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgRoot = resolve(root, 'node_modules/@earendil-works/pi-ai')
const pkg = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'))
if (pkg.version !== '1.3.0') throw new Error('Expected exact pi-ai 1.3.0')
const patch = await readFile(resolve(root, 'patches/pi-ai-1.3.0.patch'), 'utf8')
const hashes = {}
for (const section of patch.split('diff --git ').slice(1)) {
  const file = section.match(/^a\/(\S+) b\/\1/m)?.[1]
  if (!file) throw new Error('Invalid patch path')
  const path = resolve(pkgRoot, file)
  let source = await readFile(path, 'utf8')
  for (const hunk of section.split(/^@@[^\n]*\n/m).slice(1)) {
    const lines = hunk.replace(/\n$/, '').split('\n').filter(l => /^[ +\-]/.test(l))
    const before = lines.filter(l => !l.startsWith('+')).map(l => l.slice(1)).join('\n')
    const after = lines.filter(l => !l.startsWith('-')).map(l => l.slice(1)).join('\n')
    if (source.includes(before)) {
      if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Ambiguous patch ${file}`)
      source = source.replace(before, after)
    } else if (!source.includes(after)) throw new Error(`Patch preimage mismatch: ${file}`)
  }
  await writeFile(path, source)
  hashes[file] = createHash('sha256').update(source).digest('hex')
}
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/pi-ai-patch-manifest.json'), JSON.stringify({ version: pkg.version, upstream: '8bd073392eef6f54e921a093b95076248eb08cbb', files: hashes }, null, 2) + '\n')
console.log(`Verified Harness patch on ${Object.keys(hashes).length} pi-ai files`)
