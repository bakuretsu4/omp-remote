import { createHash } from "node:crypto";
import type { BlobStore } from "../backend.ts";

export interface BlobStoreOptions {
	/** Total bytes kept before the least-recently-used blobs are evicted. Default 256 MiB. */
	maxBytes?: number;
}

export interface CountingBlobStore extends BlobStore {
	/** Bytes currently held. */
	readonly size: number;
}

/**
 * Content-addressed, LRU-evicting blob store. `ref` = `b_` + 22 chars of base64url(SHA-256(bytes)),
 * so the same image uploaded or shown twice shares one entry. Refs are valid for the process lifetime
 * unless evicted.
 */
export function createBlobStore(opts: BlobStoreOptions = {}): CountingBlobStore {
	const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
	// Map iteration order == insertion order; re-inserting on access gives LRU.
	const entries = new Map<string, { bytes: Uint8Array; mimeType: string }>();
	let total = 0;

	const evict = (): void => {
		for (const [ref, e] of entries) {
			if (total <= maxBytes || entries.size <= 1) return;
			entries.delete(ref);
			total -= e.bytes.byteLength;
		}
	};

	return {
		get size() {
			return total;
		},
		put(bytes, mimeType) {
			const ref = `b_${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}`;
			const existing = entries.get(ref);
			if (existing) {
				entries.delete(ref);
				entries.set(ref, existing);
				return ref;
			}
			// Copy so callers may reuse their buffer.
			entries.set(ref, { bytes: Uint8Array.from(bytes), mimeType });
			total += bytes.byteLength;
			evict();
			return ref;
		},
		get(ref) {
			const e = entries.get(ref);
			if (!e) return undefined;
			entries.delete(ref);
			entries.set(ref, e);
			return { bytes: e.bytes, mimeType: e.mimeType };
		},
	};
}
