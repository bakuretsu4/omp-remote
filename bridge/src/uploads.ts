/**
 * Chunked uploads (PROTOCOL.md §6.5). Chunks are appended to a private temp file; `end` turns images into
 * blob refs and files into `<session cwd>/.ompr-inbox/<ts>-<name>`.
 */
import { randomBytes } from "node:crypto";
import {
	constants, existsSync, lstatSync, mkdirSync, readFileSync, appendFileSync, writeFileSync,
} from "node:fs";
import { copyFile, open, readFile, unlink, mkdir, lstat, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BlobStore, ResolvedAttachment } from "./backend.ts";
import { forbiddenPath, invalid, notFound } from "./errors.ts";
import { ensurePrivateDir, isUnder, realpathUnder } from "./safefs.ts";

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 192 * 1024;
const MAX_ACTIVE_PER_DEVICE = 8;
const IDLE_MS = 10 * 60_000;
const MAX_FILE_REFS = 256;
export const INBOX_DIR = ".ompr-inbox";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sniffImage(b: Buffer): string | undefined {
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
	if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return undefined;
}

/** Keeps a file name safe to create: basename only, `[A-Za-z0-9._-]`, no leading dots, ≤100 chars. */
export function sanitizeName(name: string): string {
	const base = basename(name.replace(/\\/g, "/"));
	let s = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
	if (s.length > 100) {
		const dot = s.lastIndexOf(".");
		const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
		s = s.slice(0, 100 - ext.length) + ext;
	}
	return s.length ? s : "file";
}

interface Upload {
	id: string;
	did: string;
	name: string;
	mime: string;
	size: number;
	purpose: "image" | "file";
	cwd: string | undefined;
	tmp: string;
	received: number;
	nextChunk: number;
	timer: NodeJS.Timeout;
}

export interface UploadDeps {
	dir: string;
	blobs: BlobStore;
	roots: () => string[];
	/** Cwd of a live session; throws when unknown. */
	sessionCwd: (sid: string) => string;
	now?: () => number;
}

export class UploadManager {
	readonly #d: UploadDeps;
	readonly #uploads = new Map<string, Upload>();
	readonly #files = new Map<string, { path: string; name: string }>();

	constructor(d: UploadDeps) {
		this.#d = d;
		ensurePrivateDir(d.dir);
	}

	get activeCount(): number {
		return this.#uploads.size;
	}

	async begin(did: string, a: { name: string; mime: string; size: number; purpose: "image" | "file"; sid?: string }): Promise<{ uploadId: string }> {
		if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > 512) throw invalid("name must be 1..512 characters");
		if (typeof a.mime !== "string" || a.mime.length > 128) throw invalid("mime must be a string");
		if (!Number.isSafeInteger(a.size) || a.size < 0) throw invalid("size must be a non-negative integer");
		if (a.size > MAX_UPLOAD_BYTES) throw invalid(`upload exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB limit`);
		if (a.purpose !== "image" && a.purpose !== "file") throw invalid("purpose must be image or file");
		if (a.purpose === "image" && !IMAGE_MIMES.has(a.mime.toLowerCase())) throw invalid("images must be png, jpeg, gif or webp");
		let cwd: string | undefined;
		if (a.purpose === "file") {
			if (typeof a.sid !== "string") throw invalid("file uploads need the target session `sid`");
			cwd = await this.#inboxCwd(a.sid);
		}
		const mine = [...this.#uploads.values()].filter(u => u.did === did).length;
		if (mine >= MAX_ACTIVE_PER_DEVICE) throw invalid("too many uploads in progress");
		const id = `u_${randomBytes(9).toString("base64url")}`;
		const tmp = join(this.#d.dir, `${id}.part`);
		writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
		const up: Upload = {
			id, did, name: a.name, mime: a.mime.toLowerCase(), size: a.size, purpose: a.purpose, cwd, tmp,
			received: 0, nextChunk: 0, timer: setTimeout(() => void this.#drop(id), IDLE_MS),
		};
		up.timer.unref();
		this.#uploads.set(id, up);
		return { uploadId: id };
	}

	chunk(did: string, a: { uploadId: string; i: number; d: string }): void {
		const up = this.#own(did, a.uploadId);
		if (!Number.isSafeInteger(a.i) || a.i !== up.nextChunk) throw invalid(`expected chunk ${up.nextChunk}`);
		if (typeof a.d !== "string" || a.d.length > Math.ceil((MAX_CHUNK_BYTES * 4) / 3) + 4) throw invalid("chunk too large");
		const bytes = Buffer.from(a.d, "base64");
		if (bytes.length > MAX_CHUNK_BYTES) throw invalid("chunk too large");
		if (up.received + bytes.length > up.size) throw invalid("received more bytes than declared");
		appendFileSync(up.tmp, bytes);
		up.received += bytes.length;
		up.nextChunk++;
		up.timer.refresh();
	}

	async end(did: string, a: { uploadId: string }): Promise<{ ref: string; path?: string }> {
		const up = this.#own(did, a.uploadId);
		try {
			if (up.received !== up.size) throw invalid(`incomplete upload: ${up.received} of ${up.size} bytes`);
			if (up.purpose === "image") {
				const bytes = await readFile(up.tmp);
				const sniffed = sniffImage(bytes);
				if (!sniffed) throw invalid("the data is not a png, jpeg, gif or webp image");
				return { ref: this.#d.blobs.put(bytes, sniffed) };
			}
			const path = await this.#writeInbox(up);
			const ref = `f_${randomBytes(9).toString("base64url")}`;
			this.#files.set(ref, { path, name: up.name });
			if (this.#files.size > MAX_FILE_REFS) this.#files.delete(this.#files.keys().next().value!);
			return { ref, path };
		} finally {
			await this.#drop(up.id);
		}
	}

	/** Resolves prompt attachment refs. Throws `invalid` for unknown or expired refs. */
	resolve(refs: { ref: string }[] | undefined): ResolvedAttachment[] {
		if (refs === undefined) return [];
		if (!Array.isArray(refs) || refs.length > 8) throw invalid("attachments must be an array of at most 8 refs");
		const out: ResolvedAttachment[] = [];
		for (const r of refs) {
			const ref = r?.ref;
			if (typeof ref !== "string") throw invalid("attachment needs {ref}");
			const f = this.#files.get(ref);
			if (f) {
				out.push({ kind: "file", path: f.path, name: f.name });
				continue;
			}
			const blob = this.#d.blobs.get(ref);
			if (!blob) throw invalid("unknown or expired attachment ref");
			out.push({ kind: "image", mimeType: blob.mimeType, dataBase64: Buffer.from(blob.bytes).toString("base64") });
		}
		return out;
	}

	/** Drops every in-flight upload (shutdown). */
	async closeAll(): Promise<void> {
		await Promise.all([...this.#uploads.keys()].map(id => this.#drop(id)));
	}

	#own(did: string, id: unknown): Upload {
		const up = typeof id === "string" ? this.#uploads.get(id) : undefined;
		if (!up || up.did !== did) throw notFound("no such upload");
		return up;
	}

	async #drop(id: string): Promise<void> {
		const up = this.#uploads.get(id);
		if (!up) return;
		this.#uploads.delete(id);
		clearTimeout(up.timer);
		await unlink(up.tmp).catch(() => {});
	}

	/** Realpath of the session cwd; must lie under a root. */
	async #inboxCwd(sid: string): Promise<string> {
		const cwd = this.#d.sessionCwd(sid);
		return realpathUnder(cwd, this.#d.roots());
	}

	async #writeInbox(up: Upload): Promise<string> {
		// Re-resolve at write time: the cwd may have been swapped for a symlink since `begin`.
		const cwd = await realpathUnder(up.cwd!, this.#d.roots());
		const inbox = join(cwd, INBOX_DIR);
		let st = await lstat(inbox).catch(() => undefined);
		if (st && (st.isSymbolicLink() || !st.isDirectory())) throw forbiddenPath(`${INBOX_DIR} is not a plain directory`);
		if (!st) {
			await mkdir(inbox, { mode: 0o700 });
			st = await lstat(inbox);
		}
		if ((st.mode & 0o777) !== 0o700) await chmod(inbox, 0o700);
		this.#excludeFromGit(cwd);
		const dest = join(inbox, `${(this.#d.now ?? Date.now)()}-${sanitizeName(up.name)}`);
		if (!isUnder(dest, inbox)) throw forbiddenPath("bad file name");
		// `wx`: never follow or overwrite an existing entry.
		const fh = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		await fh.close();
		await copyFile(up.tmp, dest);
		await chmod(dest, 0o600);
		return dest;
	}

	/** Adds `.ompr-inbox/` to `.git/info/exclude` when `cwd` is inside a git work tree with a plain `.git` dir. */
	#excludeFromGit(cwd: string): void {
		let dir = cwd;
		for (let i = 0; i < 64; i++) {
			const git = join(dir, ".git");
			if (existsSync(git)) {
				try {
					if (!lstatSync(git).isDirectory()) return;
					const info = join(git, "info");
					mkdirSync(info, { recursive: true });
					const file = join(info, "exclude");
					const line = `${INBOX_DIR}/`;
					const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
					if (!cur.split("\n").some(l => l.trim() === line)) appendFileSync(file, `${cur.length && !cur.endsWith("\n") ? "\n" : ""}${line}\n`);
				} catch {
					// excluding is best effort; the upload itself must not fail
				}
				return;
			}
			const parent = dirname(dir);
			if (parent === dir) return;
			dir = parent;
		}
	}
}
