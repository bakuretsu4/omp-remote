/**
 * `phone_*` host tools (PROTOCOL.md §6.6). Managed sessions with `hostTools:true` register these via
 * omp's `set_host_tools` while at least one capable device is connected. A call is routed to the most
 * recently active capable device as a `hosttool.call` host event and answered by `hosttool.result`.
 */
import { EventEmitter } from "node:events";
import type { DeviceCap, HostEvent, Ops } from "../../protocol/src/index.ts";
import type { Channel } from "./channel.ts";
import { forbiddenPath, invalid, notFound } from "./errors.ts";

export interface HostToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode: "essential";
}

export type HostToolContent = ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
export interface HostToolResult { content: HostToolContent; isError: boolean }

/** What a managed backend needs from the router. */
export interface HostToolHost {
	definitions(): HostToolDefinition[];
	call(sid: string, callId: string, tool: string, args: Record<string, unknown>): Promise<HostToolResult>;
	cancel(callId: string): void;
	onChange(fn: () => void): () => void;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const TOOLS: { cap: DeviceCap; def: HostToolDefinition }[] = [
	{
		cap: "location",
		def: {
			name: "phone_location",
			label: "Phone location",
			description: "Get the user's current GPS location from their phone (latitude, longitude, accuracy). The user may refuse.",
			parameters: obj({}),
			loadMode: "essential",
		},
	},
	{
		cap: "clipboard",
		def: {
			name: "phone_clipboard_get",
			label: "Phone clipboard (read)",
			description: "Read the text currently on the user's phone clipboard. The user may refuse.",
			parameters: obj({}),
			loadMode: "essential",
		},
	},
	{
		cap: "clipboard",
		def: {
			name: "phone_clipboard_set",
			label: "Phone clipboard (write)",
			description: "Put text on the user's phone clipboard so they can paste it elsewhere.",
			parameters: obj({ text: { type: "string", description: "Text to copy" } }, ["text"]),
			loadMode: "essential",
		},
	},
	{
		cap: "notify",
		def: {
			name: "phone_notify",
			label: "Phone notification",
			description: "Show a notification on the user's phone. Use sparingly, for results the user is waiting for.",
			parameters: obj({ title: { type: "string" }, message: { type: "string" } }, ["title", "message"]),
			loadMode: "essential",
		},
	},
	{
		cap: "camera",
		def: {
			name: "phone_camera_photo",
			label: "Phone camera",
			description: "Ask the user to take a photo with their phone camera and return it. The user may refuse.",
			parameters: obj({ facing: { type: "string", enum: ["back", "front"], description: "Which camera (default back)" } }),
			loadMode: "essential",
		},
	},
];

interface PendingCall {
	ch: Channel;
	sid: string;
	resolve: (r: HostToolResult) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export interface HostToolRouterOptions {
	channels: () => Channel[];
	/** Delivers a host event to one channel. */
	sendHev: (ch: Channel, e: HostEvent) => void;
	timeoutMs?: number;
	log: (m: string) => void;
}

const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export class HostToolRouter extends EventEmitter implements HostToolHost {
	readonly #o: HostToolRouterOptions;
	readonly #pending = new Map<string, PendingCall>();
	#lastSig = "";

	constructor(o: HostToolRouterOptions) {
		super();
		this.#o = o;
	}

	#capable(cap: DeviceCap): Channel[] {
		return this.#o.channels().filter(c => c.isOpen && c.caps.includes(cap));
	}

	definitions(): HostToolDefinition[] {
		return TOOLS.filter(t => this.#capable(t.cap).length > 0).map(t => t.def);
	}

	/** Call when channels open/close so sessions can re-register their tool set. */
	channelsChanged(): void {
		for (const [id, p] of this.#pending) {
			if (!p.ch.isOpen) this.#settle(id, p, new Error("the phone disconnected"));
		}
		const sig = this.definitions().map(d => d.name).join(",");
		if (sig === this.#lastSig) return;
		this.#lastSig = sig;
		this.emit("change");
	}

	onChange(fn: () => void): () => void {
		this.on("change", fn);
		return () => this.off("change", fn);
	}

	call(sid: string, callId: string, tool: string, args: Record<string, unknown>): Promise<HostToolResult> {
		const entry = TOOLS.find(t => t.def.name === tool);
		if (!entry) return Promise.reject(new Error(`unknown host tool ${tool}`));
		const target = this.#capable(entry.cap).sort((a, b) => b.lastRecv - a.lastRecv)[0];
		if (!target) return Promise.reject(new Error(`no connected phone supports ${tool} right now`));
		const { promise, resolve, reject } = Promise.withResolvers<HostToolResult>();
		const timer = setTimeout(() => {
			const p = this.#pending.get(callId);
			if (p) {
				this.#settle(callId, p, new Error("the phone did not answer within 60 s"));
				this.#o.sendHev(p.ch, { k: "hosttool.cancel", callId });
			}
		}, this.#o.timeoutMs ?? 60_000);
		this.#pending.set(callId, { ch: target, sid, resolve, reject, timer });
		try {
			this.#o.sendHev(target, { k: "hosttool.call", callId, sid, tool, args });
		} catch (e) {
			this.#settle(callId, this.#pending.get(callId)!, e as Error);
		}
		return promise;
	}

	cancel(callId: string): void {
		const p = this.#pending.get(callId);
		if (!p) return;
		this.#settle(callId, p, new Error("cancelled"));
		try {
			this.#o.sendHev(p.ch, { k: "hosttool.cancel", callId });
		} catch {
			// device already gone
		}
	}

	/** `hosttool.result` op. Only the device the call was routed to may answer it. */
	handleResult(from: Channel, a: Ops["hosttool.result"]["a"]): void {
		if (typeof a?.callId !== "string" || typeof a.ok !== "boolean") throw invalid("hosttool.result needs {callId, ok}");
		const p = this.#pending.get(a.callId);
		if (!p) throw notFound("no such pending host tool call");
		if (p.ch !== from) throw forbiddenPath("this call was routed to a different device");
		clearTimeout(p.timer);
		this.#pending.delete(a.callId);
		if (!a.ok) {
			p.resolve({ content: [{ type: "text", text: typeof a.error === "string" && a.error ? a.error : "the user declined or the tool failed" }], isError: true });
			return;
		}
		const content: HostToolContent = [];
		let bytes = 0;
		for (const c of Array.isArray(a.content) ? a.content : []) {
			if (c?.type === "text" && typeof c.text === "string") {
				bytes += c.text.length;
				content.push({ type: "text", text: c.text });
			} else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(c.mimeType)) {
				bytes += c.data.length;
				content.push({ type: "image", data: c.data, mimeType: c.mimeType });
			}
		}
		if (bytes > MAX_RESULT_BYTES) {
			p.resolve({ content: [{ type: "text", text: "result too large" }], isError: true });
			return;
		}
		p.resolve({ content: content.length ? content : [{ type: "text", text: "ok" }], isError: false });
	}

	#settle(id: string, p: PendingCall, err: Error): void {
		clearTimeout(p.timer);
		this.#pending.delete(id);
		p.reject(err);
	}
}
