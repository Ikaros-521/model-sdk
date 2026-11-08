import { createHash } from 'node:crypto'
import type { Branded } from '../core/values.js'
export type AttachmentId = Branded<'AttachmentId'>
export const AttachmentId = (value: string): AttachmentId => value as AttachmentId
export type ImageVariantId = Branded<'ImageVariantId'>
export const ImageVariantId = (value: string): ImageVariantId => value as ImageVariantId
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ImageAttachmentRef {
  attachmentId: AttachmentId
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}
export interface FileAttachmentRef { attachmentId: AttachmentId; name: string; bytes: number }
export interface ImageRequestTarget { width: number; height: number; maxBytes: number }
export interface RequestImageAttachment {
  variantId: ImageVariantId
  attachment: ImageAttachmentRef
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  depth: 'uchar'
  space: 'srgb'
  hasAlpha: boolean
}
/** Optional host port for durable/transformed bytes. No filesystem or network is assumed. */
export interface AttachmentStore {
  imageHostPath?(ref: ImageAttachmentRef): string | undefined
  readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment>
}
/**
 * Pure request-projection geometry shared by model routes and provider-side
 * request pricing. @module @deepseek-ai/dsh-attachment/request-projection
 */

/** Integer width and height of one projected image. */
export interface ProjectedDimensions {
  width: number
  height: number
}

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel budget.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns inward-rounded dimensions; small images are not enlarged.
 */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): ProjectedDimensions {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * Compute aspect-preserving integer dimensions with an exact long edge; the
 * short edge rounds to the nearest pixel, as an encoder resize by the
 * long edge alone.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param longEdge - positive target for the longer source edge.
 * @returns the target dimensions; a long edge at or above the source returns the source unchanged.
 */
export function longEdgeDimensions(
  width: number,
  height: number,
  longEdge: number,
): ProjectedDimensions {
  if (longEdge >= Math.max(width, height)) return { width, height }
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
    : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge }
}
/** In-memory immutable image references for callers without a durable attachment service.
 * No implicit decoding, resizing or format conversion. Supply prepared bytes within budgets.
 */
export class MemoryAttachmentStore implements AttachmentStore {
  private images = new Map<AttachmentId, RequestImageAttachment>()
  addImage(input: { data: Uint8Array; mediaType: ImageMediaType; width: number; height: number; name?: string }): ImageAttachmentRef {
    if (!input.data.byteLength || ![input.width, input.height].every(v => Number.isInteger(v) && v > 0)) throw new Error('Image bytes and positive integer dimensions are required')
    if (!['image/png','image/jpeg','image/webp','image/gif'].includes(input.mediaType)) throw new Error('Unsupported image media type')
    const data = Uint8Array.from(input.data)
    const attachmentId = AttachmentId('sha256:' + createHash('sha256').update(data).digest('hex'))
    const ref = Object.freeze({ attachmentId, mediaType: input.mediaType, bytes: data.byteLength, width: input.width, height: input.height, ...(input.name ? { name: input.name } : {}) })
    const prior = this.images.get(attachmentId)
    if (prior && (prior.width !== input.width || prior.height !== input.height || prior.mediaType !== input.mediaType)) throw new Error('Conflicting metadata for immutable image bytes')
    this.images.set(attachmentId, { variantId: ImageVariantId(attachmentId), attachment: ref, data, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, depth: 'uchar', space: 'srgb', hasAlpha: ref.mediaType === 'image/png' })
    return ref
  }
  async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const image = this.images.get(ref.attachmentId)
    if (!image) throw new Error('Image attachment is unavailable')
    if (image.bytes !== ref.bytes || image.width !== ref.width || image.height !== ref.height || image.mediaType !== ref.mediaType) throw new Error('Image attachment reference differs from stored bytes')
    if (image.width > target.width || image.height > target.height || image.bytes > target.maxBytes) throw new Error('Image exceeds request budget; supply resized bytes or a transforming AttachmentStore')
    return { ...image, attachment: ref, data: Uint8Array.from(image.data) }
  }
}
