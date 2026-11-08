/** Adapted from DeepSeek Harness upload-index.ts, Copyright (c) 2026 DeepSeek, MIT.
 * The original MIT license is preserved in file-store.ts and the package LICENSE.
 * This SDK uses instance-owned memory and never discovers a home directory.
 */
import { createHash } from 'node:crypto'
import type { AttachmentId, ImageVariantId } from '../../attachments/index.js'
import { DeepSeekFileScope } from './file-id.js'
import type { DeepSeekFileId, DeepSeekFileScope as FileScope } from './file-id.js'

export interface DeepSeekUploadRecord {
  scope: FileScope
  attachmentId: AttachmentId
  variantId: ImageVariantId
  fileId: DeepSeekFileId
  bytes: number
  createdAt: number
  expiresAt: number
}
export function deepSeekFileScope(baseURL: string, credentials: string): FileScope {
  return DeepSeekFileScope(createHash('sha256').update(baseURL.replace(/\/+$/u, '')).update('\0').update(credentials).digest('hex'))
}
export class DeepSeekUploadIndex {
  private records = new Map<string, DeepSeekUploadRecord>()
  async get(scope: FileScope, variantId: ImageVariantId, now: number, margin: number): Promise<DeepSeekUploadRecord | undefined> {
    const key = `${scope}\0${variantId}`
    const record = this.records.get(key)
    if (record && record.expiresAt - now > margin) return { ...record }
    if (record) this.records.delete(key)
    return undefined
  }
  async commit(candidate: DeepSeekUploadRecord, now: number, margin: number) {
    // There is no await between lookup and commit: publication is atomic in this instance.
    const key = `${candidate.scope}\0${candidate.variantId}`
    const existing = this.records.get(key)
    if (existing && existing.expiresAt - now > margin) return { record: { ...existing }, accepted: false }
    for (const [id, record] of this.records) if (record.expiresAt - now <= margin) this.records.delete(id)
    this.records.set(key, { ...candidate })
    return { record: { ...candidate }, accepted: true }
  }
  async remove(scope: FileScope, generations: readonly Pick<DeepSeekUploadRecord, 'variantId' | 'fileId'>[]): Promise<void> {
    for (const generation of generations) {
      const key = `${scope}\0${generation.variantId}`
      if (this.records.get(key)?.fileId === generation.fileId) this.records.delete(key)
    }
  }
  async clear(scope: FileScope): Promise<void> {
    for (const [key, record] of this.records) if (record.scope === scope) this.records.delete(key)
  }
}
