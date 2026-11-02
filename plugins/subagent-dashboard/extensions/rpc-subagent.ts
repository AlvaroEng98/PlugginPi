import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface RpcResponse {
	type: "response";
	id?: string;
	command?: string;
	success: boolean;
	data?: any;
	error?: string;
}

export class RpcSubagentProcess {
	private readonly proc;
	private readonly pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private requestId = 0;
	private intentionalStop = false;
	private closed = false;
	private closePromise: Promise<void>;
	private resolveClose!: () => void;

	constructor(
		command: string,
		args: string[],
		cwd: string,
		private readonly onRecord: (record: Record<string, any>) => void,
		private readonly onExit: (code: number | null, intentional: boolean) => void,
	) {
		this.closePromise = new Promise((resolve) => {
			this.resolveClose = resolve;
		});
		this.proc = spawn(command, args, {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += this.decoder.write(chunk);
			while (true) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline).replace(/\r$/, "");
				this.buffer = this.buffer.slice(newline + 1);
				this.processLine(line);
			}
		});
		this.proc.stdout?.on("end", () => {
			this.buffer += this.decoder.end();
			if (this.buffer.trim()) this.processLine(this.buffer.replace(/\r$/, ""));
			this.buffer = "";
		});
		this.proc.stderr?.on("data", () => {
			// RPC stdout is the protocol channel; diagnostics are intentionally not rendered as agent output.
		});
		this.proc.on("error", (error) => this.failPending(error));
		this.proc.on("close", (code) => {
			this.closed = true;
			this.failPending(new Error(`Subagent process exited (${code ?? "unknown"})`));
			this.onExit(code, this.intentionalStop);
			this.resolveClose();
		});
	}

	async request(command: Record<string, unknown>): Promise<RpcResponse> {
		if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) {
			throw new Error("Subagent process is not running");
		}
		const id = `subagent-${++this.requestId}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin!.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	send(record: Record<string, unknown>): void {
		if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) {
			throw new Error("Subagent process is not running");
		}
		this.proc.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
			if (error) this.failPending(error);
		});
	}

	async stop(): Promise<void> {
		if (!this.closed) {
			this.intentionalStop = true;
			this.proc.stdin?.end();
			const timeout = setTimeout(() => this.kill("SIGKILL"), 1500);
			await this.closePromise;
			clearTimeout(timeout);
		}
		// A descendant may have detached its stdio, allowing the direct child's close first.
		this.killProcessGroup("SIGKILL");
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.closed) return;
		this.intentionalStop = true;
		const pid = this.proc.pid;
		if (pid && process.platform !== "win32" && this.killProcessGroup(signal)) return;
		if (pid && process.platform === "win32" && signal === "SIGKILL") {
			const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => this.proc.kill(signal));
			killer.unref();
			return;
		}
		this.proc.kill(signal);
	}

	private killProcessGroup(signal: NodeJS.Signals): boolean {
		const pid = this.proc.pid;
		if (!pid || process.platform === "win32") return false;
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			// The process group already exited.
			return false;
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let record: Record<string, any>;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		if (record.type === "response" && typeof record.id === "string") {
			const pending = this.pending.get(record.id);
			if (pending) {
				this.pending.delete(record.id);
				if (record.success) pending.resolve(record as RpcResponse);
				else pending.reject(new Error(record.error || `RPC ${record.command || "command"} failed`));
			}
		}
		this.onRecord(record);
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
