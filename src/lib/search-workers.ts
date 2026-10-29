import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export type SearchEvent = {
  event: "preview" | "complete" | "page" | "sample" | "cache_miss" | "cancelled" | "error";
  jobId?: string;
  payload?: unknown;
  error?: string;
};

type SearchTask = {
  id: string;
  input: Record<string, unknown>;
  onEvent: (event: SearchEvent) => void;
  signal: AbortSignal;
  finished: boolean;
  removeAbortListener?: () => void;
};

let poolReference: SearchPool | undefined;

const TERMINAL_EVENTS = new Set<SearchEvent["event"]>(["complete", "page", "sample", "cache_miss", "cancelled", "error"]);

class SearchWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: SearchTask | null = null;
  private queue: SearchTask[] = [];
  private decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly index: number, private readonly onExit: (index: number) => void) {
    this.start();
  }

  get load() { return this.queue.length + (this.active ? 1 : 0); }

  enqueue(task: SearchTask) {
    if (task.signal.aborted) {
      this.finishQueued(task);
      return;
    }
    const abort = () => this.cancel(task);
    task.signal.addEventListener("abort", abort, { once: true });
    task.removeAbortListener = () => task.signal.removeEventListener("abort", abort);
    this.queue.push(task);
    this.dispatch();
  }

  cancel(task: SearchTask) {
    if (task.finished) return;
    const queued = this.queue.indexOf(task);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.finishQueued(task);
      return;
    }
    if (this.active === task) this.child?.kill("SIGUSR1");
  }

  private finishQueued(task: SearchTask) {
    if (task.finished) return;
    task.finished = true;
    task.removeAbortListener?.();
  }

  private start() {
    if (this.child) return;
    const script = path.join(process.cwd(), "scripts", "query-index.py");
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    const child = spawn(process.env.PYTHON ?? "python3", [script, "--worker"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.error("Search worker:", message);
    });
    child.on("error", (error) => {
      console.error("Could not start local search worker", error);
      this.failActive(error.message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.active) this.finish(this.active, { event: "error", error: `Search worker exited (${code ?? signal ?? "unknown"}).` });
      this.onExit(this.index);
      if (this.queue.length) setTimeout(() => { this.start(); this.dispatch(); }, 100);
    });
  }

  private read(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.event(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private event(line: string) {
    let event: SearchEvent;
    try { event = JSON.parse(line) as SearchEvent; }
    catch (error) {
      this.failActive(error instanceof Error ? error.message : "Invalid search worker response");
      return;
    }
    const task = this.active;
    if (!task) return;
    try { task.onEvent(event); }
    catch (error) { console.error("Search event handler failed", error); }
    if (event.jobId && task.input.action !== "page") poolReference?.bindJob(event.jobId, this.index);
    if (TERMINAL_EVENTS.has(event.event)) this.finish(task, event);
  }

  private failActive(message: string) {
    if (this.active) this.finish(this.active, { event: "error", error: message });
  }

  private finish(task: SearchTask, event: SearchEvent) {
    if (task.finished) return;
    task.finished = true;
    task.removeAbortListener?.();
    if (this.active === task) this.active = null;
    if (event.jobId && event.event === "cache_miss") poolReference?.unbindJob(event.jobId, this.index);
    this.dispatch();
  }

  private dispatch() {
    if (this.active || !this.queue.length) return;
    if (!this.child) this.start();
    const task = this.queue.shift();
    if (!task || task.finished) { this.dispatch(); return; }
    this.active = task;
    this.child?.stdin.write(`${JSON.stringify({ ...task.input, requestId: task.id })}\n`, (error) => {
      if (error && this.active === task) this.failActive(error.message);
    });
  }
}

class SearchPool {
  private readonly workers: SearchWorker[] = [];
  private readonly jobs = new Map<string, number>();
  private sequence = 0;

  constructor() {
    for (let index = 0; index < 2; index += 1) this.workers.push(new SearchWorker(index, (workerIndex) => this.clearWorker(workerIndex)));
  }

  bindJob(jobId: string, index: number) { this.jobs.set(jobId, index); }
  unbindJob(jobId: string, index: number) { if (this.jobs.get(jobId) === index) this.jobs.delete(jobId); }
  clearWorker(index: number) {
    for (const [jobId, workerIndex] of this.jobs) if (workerIndex === index) this.jobs.delete(jobId);
  }

  submit(input: Record<string, unknown>, onEvent: (event: SearchEvent) => void, signal: AbortSignal) {
    const requestId = randomUUID();
    const jobId = typeof input.jobId === "string" ? input.jobId : "";
    let workerIndex = jobId ? this.jobs.get(jobId) : undefined;
    if (workerIndex === undefined) {
      const loads = this.workers.map((worker) => worker.load);
      const minimum = Math.min(...loads);
      const candidates = loads.map((load, index) => ({ load, index })).filter((item) => item.load === minimum);
      workerIndex = candidates[this.sequence++ % candidates.length]?.index ?? 0;
      if (jobId && input.action !== "page") this.jobs.set(jobId, workerIndex);
    }
    const task: SearchTask = { id: requestId, input, onEvent, signal, finished: false };
    this.workers[workerIndex].enqueue(task);
    return () => this.workers[workerIndex!].cancel(task);
  }
}

const globalSearchPool = globalThis as typeof globalThis & { wildchatSearchPool?: SearchPool };
export const searchWorkers = globalSearchPool.wildchatSearchPool ??= new SearchPool();
poolReference = searchWorkers;
