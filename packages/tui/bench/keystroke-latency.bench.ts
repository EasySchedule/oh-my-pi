/**
 * Keystroke-to-frame latency benchmark for the TUI.
 *
 * Run:
 *   bun packages/tui/bench/keystroke-latency.bench.ts
 *   bun packages/tui/bench/keystroke-latency.bench.ts --json out.json --repeats 5
 *   bun packages/tui/bench/keystroke-latency.bench.ts --quick        # smoke-sized sample counts
 *   bun packages/tui/bench/keystroke-latency.bench.ts --diagnostics # adds the amplifier probe
 *
 * WHAT IS MEASURED
 *
 * `L` is the wall-clock interval from the moment the TUI takes ownership of a
 * keystroke's bytes to the moment a completed paint that *contains that
 * keystroke's effect* has been handed to the terminal.
 *
 *   t0 — immediately before the bytes reach `TUI.#handleInput`. The harness
 *        drives the real stdin path (`VirtualTerminal.sendInput` →
 *        `terminal.start(onInput)` → `#handleInput`), the same function
 *        `TUI.injectDebugInput` calls, so there is no measurement-only code path.
 *   t1 — the timestamp taken inside the `TUIOptions.onPaint` listener, which
 *        `#emitPlanFrame` invokes *after* `terminal.write(buffer)`. With
 *        `VirtualTerminal` the write is synchronous and in-process, so t1 is the
 *        app's own cost. Emulator and PTY latency are excluded by construction
 *        and are not a target.
 *
 * A paint only stops the clock when its rows contain the keystroke's effect,
 * checked by content — the editor's rendered text — and never by ordering. A
 * paint that does not contain the effect does not stop the clock however early
 * it arrives. This matters because the frame path coalesces: at a typing rate
 * faster than the render cadence one paint legitimately carries several
 * keystrokes, and that is reported as `coalescedInputs` rather than hidden.
 *
 * `L_stream` is the same shape for a streaming tool result: t0 is the commit of
 * a chunk, t1 is the first paint whose rows contain a marker from that chunk.
 *
 * WHY THERE IS NO VIRTUAL CLOCK HERE
 *
 * `#doRender` is fully synchronous, so the *frame* has no yield. The path from
 * keystroke to frame does: `#handleInput` → `requestRender()` →
 * `scheduleImmediate` → `#scheduleRender()` → `scheduleRender(cb, delay)` →
 * `#runScheduledRender` → `#executeRender` → `#doRender`. `#scheduleRender`
 * picks `max(cadenceDelay, adaptiveDelay, inputGraceDelay)` with
 * `cadenceDelay = max(0, 1000/30 - elapsed)`, and `elapsed` is measured on the
 * real clock. A virtual-clock scheduler would therefore measure the scheduling
 * *policy* deterministically and report zero variance — useless as a latency
 * baseline, and misleading, because the cadence term is usually the largest
 * part of `L`. The headline number uses the real scheduler, every sample is
 * decomposed into input-handling / scheduler-delay / frame-cost so the cadence
 * term is visible rather than buried in an average, and `--repeats` is how the
 * run-to-run noise band is established.
 *
 * DETERMINISM
 *
 * The fixture is seed-fixed (mulberry32; no `Math.random`, no wall-clock input).
 * What remains non-deterministic is the measurement itself — that is the point —
 * so repeats, not a fixed seed, are what make the number trustworthy.
 *
 * WHY THE VERDICT IS DECIDED ACROSS PASSES, NOT WITHIN ONE
 *
 * A verdict that depends on whether this pass landed above or below the target
 * cannot be stable across passes, and a verdict that flips is not a measurement.
 * So the §3.1 target comparison is made against the *band* across all passes, and
 * every pass is then stamped with the same verdict, computed once from that band.
 * There are four verdicts, and the fourth is the one that matters:
 *
 *   pass           the band clears the target on every pass
 *   fail           the band is outside the target on every pass, or a correctness
 *                  fault (lost keystroke, 250 ms loop block) was observed
 *   invalid        the run never produced a comparable measurement — percentiles
 *                  below the §4.6 minimum, or the §4.5 validity gate not met
 *   unresolvable   the band spans the target, so the harness measured that it
 *                  cannot tell which side of the line this row is on
 *
 * `unresolvable` is the honest answer for a target that sits inside the noise, and
 * it is what makes a 30% improvement threshold adjudicable or not: a band wider than
 * the improvement being claimed cannot decide it, and saying so is the finding.
 *
 * `--repeats` sets how wide the band is, so `--repeats 1` produces no band and no
 * `unresolvable` verdict; it reports the single pass and says the band was not
 * measured.
 *
 * `--quick` IS NOT A FULL RUN
 *
 * `--quick` uses different sample counts over a smaller transcript. It is a smoke
 * check. It says so in a banner before any number it prints, it suppresses the
 * projection block entirely, and it sets `comparableToFullRun: false` in the JSON, so
 * its percentiles cannot be pasted as a full run's.
 *
 * SCENARIO LABELS
 *
 * Scenario ids follow the product spec's §3.1 table. One label deviates and says
 * so in its name: `D-editor-nav`. `oh-my-pi` has no in-TUI transcript scrollback
 * navigation — the interactive TUI never scrolls its own transcript, scrollback
 * belongs to the terminal, and `TranscriptContainer` exposes no scroll API. The
 * spec's row D therefore describes terminal-level scrolling, which the same spec
 * puts out of scope as an optimisation target (§6.4). What is measurable on the
 * app's input→frame path is the editor's own viewport paging and caret
 * navigation, so that is what this row measures.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { TranscriptContainer, type TranscriptStableRow } from "../src/chrome/transcript-container";
import { initTheme } from "../src/theme";
import { Text } from "../src/components/text";
import { COMPOSER_DEFAULTS, Composer } from "../src/prompt/composer";
import type { Component, TuiPaint } from "../src/tui";
import { VirtualTerminal } from "../test/virtual-terminal";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
	jsonPath: string | undefined;
	repeats: number;
	quick: boolean;
	diagnostics: boolean;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { jsonPath: undefined, repeats: 1, quick: false, diagnostics: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--json") {
			const next = argv[++i];
			if (next === undefined) throw new Error("--json needs a path");
			options.jsonPath = next;
		} else if (arg === "--repeats") {
			const next = Number(argv[++i]);
			if (!Number.isFinite(next) || next < 1) throw new Error("--repeats must be >= 1");
			options.repeats = next;
		} else if (arg === "--quick") {
			options.quick = true;
		} else if (arg === "--diagnostics") {
			options.diagnostics = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

// ---------------------------------------------------------------------------
// Deterministic fixture text
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, seed-fixed. `Math.random` is never used. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = [
	"render",
	"frame",
	"transcript",
	"scrollback",
	"viewport",
	"measured",
	"latency",
	"cadence",
	"keystroke",
	"retired",
	"settled",
	"committed",
	"allocation",
	"backpressure",
	"terminal",
	"emulator",
	"sanitize",
	"highlight",
	"streaming",
	"backlog",
] as const;

/** Prose of approximately `chars` characters; deterministic for a given seed. */
function prose(random: () => number, chars: number): string {
	const parts: string[] = [];
	let length = 0;
	while (length < chars) {
		const word = WORDS[Math.floor(random() * WORDS.length)]!;
		parts.push(word);
		length += word.length + 1;
	}
	return parts.join(" ");
}

/** Build/link noise of the shape `rg`, `cargo build`, `git log -p` produce. */
function noiseLines(random: () => number, lines: number, columns: number): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const pad = " ".repeat(Math.floor(random() * 8));
		const kind = Math.floor(random() * 4);
		const head =
			kind === 0
				? `packages/tui/src/chrome/module_${Math.floor(random() * 90)}.ts:${40 + Math.floor(random() * 900)}`
				: kind === 1
					? `   Compiling pi-tui v18.4.3 (${random().toFixed(4)}s)`
					: kind === 2
						? `warning: unused variable \`state_${Math.floor(random() * 90)}\``
						: `commit ${Math.floor(random() * 0xffffff)
								.toString(16)
								.padStart(6, "0")}`;
		const rest = prose(random, Math.max(8, columns - head.length - pad.length - 2));
		out.push(`${head}${pad} ${rest}`.slice(0, columns));
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Summary {
	count: number;
	min: number;
	mean: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number;
	percentilesValid: boolean;
}

const round = (value: number): number => Number(value.toFixed(4));

/**
 * Percentiles are reported only once the sample count reaches the scenario's
 * §4.6 minimum. Below it, p50/p95/p99 are `null`: a p99 from 50 samples is not a
 * p99, and printing one would be the more flattering lie.
 */
function summarize(samples: readonly number[], minSamples: number): Summary {
	if (samples.length === 0) {
		return {
			count: 0,
			min: Number.NaN,
			mean: Number.NaN,
			p50: null,
			p95: null,
			p99: null,
			max: Number.NaN,
			percentilesValid: false,
		};
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number): number => {
		const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
		return sorted[index]!;
	};
	let total = 0;
	for (const value of samples) total += value;
	const valid = samples.length >= minSamples;
	return {
		count: samples.length,
		min: round(sorted[0]!),
		mean: round(total / samples.length),
		p50: valid ? round(at(50)) : null,
		p95: valid ? round(at(95)) : null,
		p99: valid ? round(at(99)) : null,
		max: round(sorted[sorted.length - 1]!),
		percentilesValid: valid,
	};
}

// ---------------------------------------------------------------------------
// Instrumented transcript block
// ---------------------------------------------------------------------------

/**
 * Per-frame render accounting, split by block class.
 *
 * Process-global because a frame walks blocks the harness holds no reference to,
 * and the paint listener reads them at the frame boundary. The split matters: the
 * settled/retired region and the growing streaming block are different work with
 * different costs, and averaging them would hide which one is expensive.
 */
const frameRenders = {
	calls: 0,
	nanos: 0,
	/** Renders of the growing streaming tool-result block. */
	streamCalls: 0,
	streamNanos: 0,
	/** Renders of every other live transcript block. */
	otherCalls: 0,
	otherNanos: 0,
};

/**
 * An append-only transcript block that delegates to a real `Text` and counts how
 * often — and how expensively — the transcript re-renders it.
 *
 * This is the measurement that settles the question the product spec §8.2 calls a
 * hypothesis: does one frame render each live block once (the
 * `TranscriptContainer.#measuredRows` memo) or several times (the amplifier
 * described in `docs/tui-runtime-internals.md:51`)? The answer is a per-frame
 * count plus nanoseconds, not an opinion.
 */
class ProbedBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	readonly #text: Text;
	#finalized: boolean;
	#stable: readonly TranscriptStableRow[];

	constructor(text: Text, rows: number, finalized: boolean) {
		this.#text = text;
		this.#finalized = finalized;
		this.#stable = Array.from({ length: rows }, (_, i) => ({ key: String(i) }));
	}

	/** The wrapped component, for subclasses that grow the block's text. */
	protected get text(): Text {
		return this.#text;
	}

	invalidate(): void {
		this.#text.invalidate();
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#finalized ? this.#stable : [];
	}

	/**
	 * Real append-only blocks serve their stable rows from their own ledger cache
	 * (see `AssistantMessage.renderTranscriptStableRows`), never by re-rendering the
	 * block. The proxy does the same against its last render, so it does not
	 * inflate the very render count this harness exists to measure.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (this.#lastWidth !== width || this.#lastRows === undefined) {
			this.render(width);
		}
		return (this.#lastRows ?? []).slice(0, count);
	}
	#lastWidth = -1;
	#lastRows: readonly string[] | undefined;

	render(width: number): readonly string[] {
		const started = Bun.nanoseconds();
		frameRenders.calls++;
		if (this.isStream) frameRenders.streamCalls++;
		else frameRenders.otherCalls++;
		try {
			const rows = this.#text.render(width);
			this.#lastWidth = width;
			this.#lastRows = rows;
			return rows;
		} finally {
			const elapsed = Bun.nanoseconds() - started;
			frameRenders.nanos += elapsed;
			if (this.isStream) frameRenders.streamNanos += elapsed;
			else frameRenders.otherNanos += elapsed;
		}
	}

	/** Subclasses that wrap a growing block set this so their cost is separable. */
	protected isStream = false;
}

/**
 * The tail block of scenarios E and F: a bash-style tool result that grows by
 * appended chunks, each carrying a marker unique to that chunk, so "the paint
 * that shows this chunk" is decided by content and not by arrival order.
 */
class StreamingToolResult extends ProbedBlock {
	#buffer = "";

	constructor(text: Text) {
		super(text, 8, false);
		this.isStream = true;
	}

	/** Seed the block with output that arrived before the stream started. */
	setSeed(text: string): void {
		this.#buffer = text;
		this.text.setText(text);
	}

	/** Append one chunk; returns the marker that identifies it inside a paint. */
	append(chunk: string, index: number): string {
		const marker = `chunk${String(index).padStart(4, "0")}end`;
		this.#buffer += `${chunk}\n${marker}\n`;
		this.text.setText(this.#buffer);
		return marker;
	}
}

// ---------------------------------------------------------------------------
// Paint content matching
// ---------------------------------------------------------------------------

/**
 * Normalise a paint's rows into the text a human would read. The editor renders
 * inside a border (`╰─ text`), so border glyphs and whitespace are dropped
 * before matching; what remains is prompt content, which is precisely "this
 * keystroke's effect is on screen".
 */
function paintText(paint: TuiPaint): string {
	let out = "";
	for (const row of paint.viewport) out += Bun.stripANSI(row);
	return out.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼ \t\r\n]/g, "");
}

// ---------------------------------------------------------------------------
// Loop-block detector
// ---------------------------------------------------------------------------

/**
 * The repo's own definition of a stuck UI is a 250 ms event-loop block
 * (`LoopWatchdog.thresholdMs`, `packages/tui/src/loop-watchdog.ts`). The watchdog
 * inside `TUI` owns no external observer, so the harness runs the equivalent
 * measurement itself: a periodic tick whose inter-tick gap is the block duration.
 *
 * The tick is 25 ms rather than `setTimeout(…, 0)`: a zero-delay timer chain
 * saturates the loop the benchmark is trying to measure, which would make every
 * latency number in the run a measurement artefact. 25 ms resolution is well
 * inside the 250 ms threshold being tested.
 */
class LoopBlockDetector {
	#timer: ReturnType<typeof setInterval> | undefined;
	#last = 0;
	#armed = false;
	readonly gaps: number[] = [];

	constructor(private readonly thresholdMs = 250) {}

	start(): void {
		if (this.#armed) return;
		this.#armed = true;
		this.#last = performance.now();
		this.#timer = setInterval(() => {
			const now = performance.now();
			const gap = now - this.#last;
			if (gap > this.thresholdMs) this.gaps.push(round(gap));
			this.#last = now;
		}, 25);
	}

	stop(): void {
		this.#armed = false;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	get events(): number[] {
		return this.gaps;
	}
}

// ---------------------------------------------------------------------------
// Latency probe
// ---------------------------------------------------------------------------

interface PendingKeystroke {
	t0: number;
	handleEnd: number;
	expected: string;
}

/**
 * One resolved keystroke.
 *
 * `frameCost` and `scheduleDelay` are filled in after the run, not in the paint
 * listener. `#executeRender` publishes `lastFrameCostMs` *after* `#doRender`
 * returns, so the value readable from inside the listener is the previous frame's.
 * Reading it there would attribute the previous frame's cost to this frame and
 * make the decomposition come out with a negative residual. The paint index is
 * recorded instead, and `resolveFrameCosts` pairs each paint with the cost
 * measured on the next tick — which is that same frame's cost — falling back to
 * the value read after the run for the final paint.
 */
interface Sample {
	L: number;
	inputHandle: number;
	handleEnd: number;
	paintIndex: number;
	frameCost: number;
	scheduleDelay: number;
}

interface PaintRecord {
	at: number;
	/** This frame's cost, filled in by `resolveFrameCosts`. */
	frameCostMs: number;
	/** The listener-time `lastFrameCostMs`, i.e. the *previous* frame's cost. */
	rawLastFrameCostMs: number;
	blockRenders: number;
	blockMs: number;
	streamRenders: number;
	streamMs: number;
	otherRenders: number;
	otherMs: number;
}

interface RenderCounts {
	/** `TUI.lastFrameCostMs` as read inside the listener: the previous frame's. */
	lastFrameCostMs: number;
	calls: number;
	nanos: number;
	streamCalls: number;
	streamNanos: number;
	otherCalls: number;
	otherNanos: number;
}

/**
 * Collects `L` for a stream of keystrokes fired on a fixed real-time schedule.
 *
 * Keystrokes are deliberately *not* serialised against their own paint. Waiting
 * for each paint before sending the next keystroke would remove exactly the
 * coalescing a fast typist produces and would report a flattering number for a
 * shape nobody types into. Instead each keystroke is recorded as pending, and a
 * paint resolves every pending keystroke whose effect its rows contain. Since
 * each `expected` is the editor's full text after that keystroke, a paint that
 * shows keystroke *j* necessarily shows every earlier keystroke too, so the
 * earliest matching paint is the correct t1 for all of them.
 */
class LatencyProbe {
	readonly samples: Sample[] = [];
	readonly paints: PaintRecord[] = [];
	readonly interKeyIntervals: number[] = [];
	readonly pending: PendingKeystroke[] = [];
	coalescedInputs = 0;
	lostInputs = 0;
	#lastKeystrokeAt = Number.NEGATIVE_INFINITY;
	#sent = 0;
	#resolved = 0;

	/** Hand one keystroke's bytes to the real input path. Returns t0. */
	send(at: number, expected: string): number {
		if (Number.isFinite(this.#lastKeystrokeAt)) this.interKeyIntervals.push(at - this.#lastKeystrokeAt);
		this.#lastKeystrokeAt = at;
		this.#sent++;
		this.pending.push({ t0: at, handleEnd: Number.NaN, expected });
		return at;
	}

	/** Called immediately after the synchronous `sendInput` returns. */
	markHandled(handleEnd: number): void {
		const last = this.pending[this.pending.length - 1];
		if (last !== undefined) last.handleEnd = handleEnd;
	}

	/** Called from the `onPaint` listener, i.e. after `terminal.write` returned. */
	observePaint(paint: TuiPaint, at: number, counts: RenderCounts): void {
		this.paints.push({
			at,
			frameCostMs: Number.NaN,
			rawLastFrameCostMs: counts.lastFrameCostMs,
			blockRenders: counts.calls,
			blockMs: counts.nanos,
			streamRenders: counts.streamCalls,
			streamMs: counts.streamNanos,
			otherRenders: counts.otherCalls,
			otherMs: counts.otherNanos,
		});
		let keep = 0;
		for (const entry of this.pending) {
			const effect = entry.expected.length === 0 || paintText(paint).includes(entry.expected);
			if (!effect) {
				this.pending[keep++] = entry;
				continue;
			}
			this.samples.push({
				L: at - entry.t0,
				inputHandle: entry.handleEnd - entry.t0,
				handleEnd: entry.handleEnd,
				paintIndex: this.paints.length - 1,
				frameCost: Number.NaN,
				scheduleDelay: Number.NaN,
			});
		}
		this.pending.length = keep;
		const resolved = this.#sent - this.pending.length;
		if (resolved > this.#resolved + 1) this.coalescedInputs += resolved - this.#resolved - 1;
		this.#resolved = resolved;
	}

	/** Anything still pending after the run never reached a paint. */
	finish(): void {
		this.lostInputs = this.pending.length;
		this.pending.length = 0;
	}

	/**
	 * Pair every paint with its own frame cost and decompose each sample.
	 *
	 * `lastFrameCostMs` for the frame that ended at paint *i* is readable at paint
	 * *i+1*, and for the final frame from the value left behind after the run. The
	 * per-paint block timings were already captured at the right instant, so this
	 * is the only place the two series can be lined up without one of them being a
	 * frame stale.
	 */
	resolveFrameCosts(finalFrameCostMs: number): void {
		for (let i = 0; i < this.paints.length; i++) {
			const next = this.paints[i + 1];
			this.paints[i]!.frameCostMs = next === undefined ? finalFrameCostMs : next.rawLastFrameCostMs;
		}
		for (const sample of this.samples) {
			sample.frameCost = this.paints[sample.paintIndex]?.frameCostMs ?? finalFrameCostMs;
			const raw = this.paints[sample.paintIndex]?.at ?? Number.NaN;
			const delay = raw - sample.handleEnd - sample.frameCost;
			sample.scheduleDelay = delay > 0 ? delay : 0;
		}
	}
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const COLUMNS = 120;
const ROWS = 40;
const SCROLLBACK = 200_000;

/**
 * Settled blocks the product spec §4.5 requires the live region to still hold for
 * its target to be comparable. See {@link validityGate} for why this harness can
 * never reach it.
 */
const SETTLED_BLOCK_FLOOR = 200;

interface FixtureSpec {
	turns: number;
	bashLines: number;
	rows: number;
	columns: number;
	/** Bytes of bash output each streaming chunk appends. */
	streamChunkBytes: number;
	seed: number;
}

const LONG_TRANSCRIPT: FixtureSpec = {
	turns: 40,
	bashLines: 20_000,
	rows: ROWS,
	columns: COLUMNS,
	streamChunkBytes: 8192,
	seed: 1,
};

interface Fixture {
	composer: Composer;
	terminal: VirtualTerminal;
	transcript: TranscriptContainer;
	probes: ProbedBlock[];
	stream: StreamingToolResult;
	/** Times the composer's escape hatch asked to terminate the process. */
	exits: number[];
}

function buildFixture(spec: FixtureSpec): Fixture {
	const random = mulberry32(spec.seed);
	const terminal = new VirtualTerminal(spec.columns, spec.rows, SCROLLBACK);
	const exits: number[] = [];
	const composer = new Composer({
		terminal,
		tuiOptions: { onPaint: () => {} },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		// Ctrl+C is a measured scenario (spec §3.1 row G), and the default exit
		// handler tears the process down. Stub it and count the calls instead:
		// process teardown is dominated by unrelated shutdown work, so including it
		// would measure the wrong thing. Counting the calls still proves the
		// escape hatch fired, which a paint-arrival check alone does not.
		exit: code => {
			exits.push(code);
		},
	});
	const transcript = new TranscriptContainer();
	const probes: ProbedBlock[] = [];

	for (let turn = 0; turn < spec.turns; turn++) {
		const user = new ProbedBlock(new Text(prose(random, 300), 0, 0), 2, true);
		probes.push(user);
		transcript.addChild(user);

		const code = Array.from({ length: 40 }, (_, i) => `  ${String(i).padStart(3, " ")} | ${prose(random, 60)}`).join(
			"\n",
		);
		const assistant = new ProbedBlock(
			new Text(`${prose(random, 1200)}\n\n\`\`\`ts\n${code}\n\`\`\``, 0, 0),
			20,
			true,
		);
		probes.push(assistant);
		transcript.addChild(assistant);
	}

	const stream = new StreamingToolResult(new Text("", 0, 0));
	// The tail block is not finalized: it is a running tool result, and its rows
	// arrive by append. Seed it with the non-streaming payload the scenario wants.
	stream.setSeed(noiseLines(random, spec.bashLines, 80));
	probes.push(stream);
	transcript.addChild(stream);

	composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
	composer.ui.setFocus(composer.editor);
	composer.start({});
	return { composer, terminal, transcript, probes, stream, exits };
}

function blockStates(transcript: TranscriptContainer): { settled: number; committed: number; active: number } {
	let settled = 0;
	let committed = 0;
	let active = 0;
	for (const state of transcript.blockStates()) {
		if (state === "settled") settled++;
		else if (state === "committed") committed++;
		else active++;
	}
	return { settled, committed, active };
}

/** Let the throttled render pipeline settle, then idle one cadence period. */
async function settle(terminal: VirtualTerminal, ms = 150): Promise<void> {
	await terminal.waitForRender();
	await Bun.sleep(ms);
	await terminal.flush();
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

const TYPED_TEXT = ((): string => {
	const random = mulberry32(0x5eed);
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	let out = "";
	for (let i = 0; i < 200; i++) out += alphabet[Math.floor(random() * alphabet.length)]!;
	return out;
})();

interface ScriptOptions {
	keystrokes: number;
	intervalMs: number;
	/** Concurrent tool-output stream: 0 disables it. */
	streamChunkBytes: number;
	streamEveryMs: number;
	/** Keys to send instead of typing text (scenario D). */
	keys?: readonly string[];
	/** Resolve a keystroke by "a paint happened" rather than by content. */
	contentChecked: boolean;
}

/**
 * Live-region shape over the course of a run.
 *
 * The product spec §4.5 requires the harness to prove it preserved the expensive
 * shape. Sampling only at the end is not enough: `TranscriptContainer` retires
 * settled blocks into native scrollback under capacity pressure, so by the time
 * the keystrokes stop the live region can be empty and the run would flatter
 * itself. These are the numbers a reviewer needs in order to see that the settled
 * region was populated *while* the measurement was being taken.
 */
interface ShapeSeries {
	samples: number;
	settledMedian: number;
	settledMin: number;
	settledMax: number;
	committedEnd: number;
	activeEnd: number;
}

interface RunOutcome {
	probe: LatencyProbe;
	detector: LoopBlockDetector;
	runMs: number;
	steadyFrameCostMs: number;
	streamChunks: number;
	shape: ShapeSeries;
}

function settledCount(transcript: TranscriptContainer): number {
	let settled = 0;
	for (const state of transcript.blockStates()) if (state === "settled") settled++;
	return settled;
}

function shapeOf(transcript: TranscriptContainer, settledDuringRun: readonly number[]): ShapeSeries {
	let committed = 0;
	let active = 0;
	for (const state of transcript.blockStates()) {
		if (state === "committed") committed++;
		else if (state !== "settled") active++;
	}
	const sorted = [...settledDuringRun].sort((a, b) => a - b);
	return {
		samples: settledDuringRun.length,
		settledMedian: sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0),
		settledMin: sorted[0] ?? 0,
		settledMax: sorted[sorted.length - 1] ?? 0,
		committedEnd: committed,
		activeEnd: active,
	};
}

async function runScript(fixture: Fixture, options: ScriptOptions): Promise<RunOutcome> {
	const { composer, terminal, transcript, stream } = fixture;
	await settle(terminal, 200);

	const probe = new LatencyProbe();
	const detector = new LoopBlockDetector();
	const settledDuringRun: number[] = [];
	frameRenders.calls = 0;
	frameRenders.nanos = 0;
	let paints = 0;

	const unsubscribe = composer.ui.addPaintListener(paint => {
		const at = performance.now();
		paints++;
		// `lastFrameCostMs` is the frame *before* this one: `#executeRender`
		// assigns it after `#doRender` returns, and the listener runs inside
		// `#doRender`. Recorded as-is, with the one-frame lag stated in the output
		// notes, rather than silently shifted onto the wrong frame.
		probe.observePaint(paint, at, {
			lastFrameCostMs: composer.ui.lastFrameCostMs,
			calls: frameRenders.calls,
			nanos: frameRenders.nanos / 1e6,
			streamCalls: frameRenders.streamCalls,
			streamNanos: frameRenders.streamNanos / 1e6,
			otherCalls: frameRenders.otherCalls,
			otherNanos: frameRenders.otherNanos / 1e6,
		});
		frameRenders.calls = 0;
		frameRenders.nanos = 0;
		frameRenders.streamCalls = 0;
		frameRenders.streamNanos = 0;
		frameRenders.otherCalls = 0;
		frameRenders.otherNanos = 0;
		// Every fifth paint is enough to characterise the live region and keeps
		// the accounting itself off the measured path.
		if (paints % 5 === 0) settledDuringRun.push(settledCount(transcript));
	});

	detector.start();
	const startedAt = performance.now();
	const keys = options.keys;
	let typed = "";
	let streamChunks = 0;
	const streamEvery = Math.max(1, Math.round(options.streamEveryMs / Math.max(1, options.intervalMs)));
	for (let i = 0; i < options.keystrokes; i++) {
		const due = startedAt + i * options.intervalMs;
		const wait = due - performance.now();
		if (wait > 0.5) await Bun.sleep(wait);
		if (options.streamChunkBytes > 0 && i > 0 && i % streamEvery === 0) {
			stream.append(
				noiseLines(mulberry32(0xb000 + i), Math.round(options.streamChunkBytes / 80), 80),
				streamChunks++,
			);
			composer.ui.requestRender();
		}
		const data = keys === undefined ? TYPED_TEXT[i % TYPED_TEXT.length]! : keys[i % keys.length]!;
		if (keys === undefined) typed += data;
		probe.send(performance.now(), options.contentChecked ? typed : "");
		terminal.sendInput(data);
		probe.markHandled(performance.now());
	}

	// Let the last keystroke's paint land.
	await settle(terminal, 300);
	const runMs = performance.now() - startedAt;
	detector.stop();
	unsubscribe();
	probe.finish();
	// Read the final frame cost before stopping: `stop()` does not clear it, but
	// keeping the read adjacent to the run makes the ordering obvious.
	const steadyFrameCostMs = composer.ui.lastFrameCostMs;
	probe.resolveFrameCosts(steadyFrameCostMs);
	return {
		probe,
		detector,
		runMs,
		steadyFrameCostMs,
		streamChunks,
		shape: shapeOf(transcript, settledDuringRun),
	};
}

// ---------------------------------------------------------------------------
// Series assembly
// ---------------------------------------------------------------------------

interface SeriesResult {
	latency: Summary;
	inputHandle: Summary;
	scheduleDelay: Summary;
	frameCost: Summary;
	coalescedInputs: number;
	lostInputs: number;
	frames: number;
	renderRatePerSecond: number;
	dutyCycle: number;
	blockRendersPerFrame: number;
	blockMsPerFrame: number;
	/** Mean renders per frame of the growing streaming block, and their mean cost. */
	streamRendersPerFrame: number;
	streamMsPerFrame: number;
	streamMsPerRender: number;
	/** Mean renders per frame of every other live block, and their mean cost. */
	otherRendersPerFrame: number;
	otherMsPerFrame: number;
	/** Frame cost not attributed to any live block: layout, prepare, terminal write. */
	residualMsPerFrame: number;
	shape: ShapeSeries;
	steadyFrameCostMs: number;
	loopBlockedEvents: number;
	interKeyIntervalMs: Summary;
}

function seriesFrom(outcome: RunOutcome, minSamples: number): SeriesResult {
	const { probe, detector, shape, runMs, steadyFrameCostMs } = outcome;
	const paints = probe.paints;
	let blockRenderTotal = 0;
	let blockMsTotal = 0;
	let frameCostTotal = 0;
	let streamRenderTotal = 0;
	let streamMsTotal = 0;
	let otherRenderTotal = 0;
	let otherMsTotal = 0;
	for (const paint of paints) {
		blockRenderTotal += paint.blockRenders;
		blockMsTotal += paint.blockMs;
		frameCostTotal += paint.frameCostMs;
		streamRenderTotal += paint.streamRenders;
		streamMsTotal += paint.streamMs;
		otherRenderTotal += paint.otherRenders;
		otherMsTotal += paint.otherMs;
	}
	const frames = Math.max(1, paints.length);
	return {
		latency: summarize(
			probe.samples.map(s => s.L),
			minSamples,
		),
		inputHandle: summarize(
			probe.samples.map(s => s.inputHandle),
			minSamples,
		),
		scheduleDelay: summarize(
			probe.samples.map(s => s.scheduleDelay),
			minSamples,
		),
		frameCost: summarize(
			probe.samples.map(s => s.frameCost),
			minSamples,
		),
		coalescedInputs: probe.coalescedInputs,
		lostInputs: probe.lostInputs,
		frames: paints.length,
		renderRatePerSecond: round((paints.length / runMs) * 1000),
		// Render duty cycle: total frame seconds per second of run time. The
		// product spec §5.1 caps this at 0.60 while streaming.
		dutyCycle: round((frameCostTotal / runMs) * 1000),
		blockRendersPerFrame: paints.length === 0 ? 0 : round(blockRenderTotal / frames),
		blockMsPerFrame: paints.length === 0 ? 0 : round(blockMsTotal / frames),
		streamRendersPerFrame: round(streamRenderTotal / frames),
		streamMsPerFrame: round(streamMsTotal / frames),
		streamMsPerRender: streamRenderTotal === 0 ? 0 : round(streamMsTotal / streamRenderTotal),
		otherRendersPerFrame: round(otherRenderTotal / frames),
		otherMsPerFrame: round(otherMsTotal / frames),
		residualMsPerFrame: paints.length === 0 ? 0 : round((frameCostTotal - blockMsTotal) / frames),
		shape,
		steadyFrameCostMs: round(steadyFrameCostMs),
		loopBlockedEvents: detector.events.length,
		interKeyIntervalMs: summarize(probe.interKeyIntervals, 0),
	};
}

// ---------------------------------------------------------------------------
// Scenario E: result-to-first-paint
// ---------------------------------------------------------------------------

interface StreamResult {
	latency: Summary;
	chunks: number;
	/** Chunks whose marker never reached a paint. Must be 0. */
	lostChunks: number;
	totalBytes: number;
	loopBlockedEvents: number;
	frames: number;
	settledBlocks: number;
	committedBlocks: number;
	activeBlocks: number;
}

/**
 * `L_stream` — for a streaming tool result there is no keystroke, so t0 is the
 * commit of a chunk and t1 is the first paint whose rows contain that chunk's
 * marker. The product spec §3.1 row E asks for results above 200 KB, so the run
 * appends until the block has passed that and then reports per-chunk latency.
 */
async function runStream(fixture: Fixture, chunks: number, chunkBytes: number): Promise<StreamResult> {
	const { composer, terminal, transcript, stream } = fixture;
	await settle(terminal, 250);
	const detector = new LoopBlockDetector();
	const samples: number[] = [];
	const pending: { t0: number; marker: string }[] = [];
	let frames = 0;
	const unsubscribe = composer.ui.addPaintListener(paint => {
		frames++;
		const at = performance.now();
		const text = paintText(paint);
		let keep = 0;
		for (const entry of pending) {
			if (text.includes(entry.marker)) samples.push(at - entry.t0);
			else pending[keep++] = entry;
		}
		pending.length = keep;
	});
	detector.start();
	const lines = Math.max(1, Math.round(chunkBytes / 80));
	let totalBytes = 0;
	for (let i = 0; i < chunks; i++) {
		const chunk = noiseLines(mulberry32(0xc000 + i), lines, 80);
		const t0 = performance.now();
		const marker = stream.append(chunk, i);
		pending.push({ t0, marker });
		totalBytes += chunkBytes;
		composer.ui.requestRender();
		// One chunk at a time, paced on the real clock: the paint that shows this
		// chunk must land before the next is committed, which is both the shape the
		// product spec §4.4 asks for and the only way to keep attribution
		// one-chunk-per-paint. A chunk whose marker never reaches a paint is
		// counted, not dropped.
		const deadline = Date.now() + 1_000;
		while (pending.length > 0 && Date.now() < deadline) await Bun.sleep(1);
	}
	await settle(terminal, 200);
	detector.stop();
	unsubscribe();
	const states = blockStates(transcript);
	return {
		latency: summarize(samples, chunks),
		chunks,
		lostChunks: pending.length,
		totalBytes,
		loopBlockedEvents: detector.events.length,
		frames,
		settledBlocks: states.settled,
		committedBlocks: states.committed,
		activeBlocks: states.active,
	};
}

// ---------------------------------------------------------------------------
// Scenario D: editor navigation
// ---------------------------------------------------------------------------

const NAV_KEYS = ["\x1b[5~", "\x1b[6~", "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"] as const;

// ---------------------------------------------------------------------------
// Scenario G: Ctrl+C
// ---------------------------------------------------------------------------

interface CtrlCResult {
	latency: Summary;
	sessions: number;
	/** Sessions where the escape hatch escalated to process exit. Must be 0. */
	exits: number;
	/** Sessions whose paint still showed the draft the press was meant to clear. */
	draftSurvived: number;
	loopBlockedEvents: number;
	frameCost: Summary;
}

/** Await the next paint after `subscribe`, using the repo's `Promise.withResolvers`. */
function nextPaint(subscribe: (resolve: (paint: TuiPaint) => void) => () => void): Promise<TuiPaint> {
	const deferred = Promise.withResolvers<TuiPaint>();
	const unsubscribe = subscribe(paint => {
		unsubscribe();
		deferred.resolve(paint);
	});
	return deferred.promise;
}

/**
 * `L` for the Ctrl+C escape hatch, measured the way the product spec §3.1 row G
 * describes it: pressing Ctrl+C on a session that looks stuck and seeing the UI
 * respond.
 *
 * One press per session, and a fresh session per sample, for two reasons. First,
 * `#handleInterrupt` escalates a second press inside `DOUBLE_INTERRUPT_MS` (500 ms)
 * to process exit, so a press stream would tear the TUI down mid-run. Second, a
 * reused session would measure the *second* interrupt, which is the escalation
 * path, not the one a user means. Each session types a fixed draft first, so the
 * sample is content-verified in both directions: the draft is on screen when the
 * press lands, and gone from the paint that ends the clock.
 */
async function runCtrlC(sessions: number, draftChars: number): Promise<CtrlCResult> {
	const samples: number[] = [];
	const costs: number[] = [];
	let exits = 0;
	let draftSurvived = 0;
	const detector = new LoopBlockDetector();
	detector.start();
	for (let session = 0; session < sessions; session++) {
		// A short transcript keeps the per-session cost down: the point of row G is
		// the escape hatch's latency, not the size of the transcript, and 150
		// sessions of a 20,000-line fixture would dominate the run's wall clock.
		const fixture = buildFixture({ ...LONG_TRANSCRIPT, turns: 6, bashLines: 60, seed: 40 + session });
		const { composer, terminal } = fixture;
		await settle(terminal, 120);
		const draft = "y".repeat(draftChars);
		for (const ch of draft) terminal.sendInput(ch);
		const drafted = await nextPaint(resolve => composer.ui.addPaintListener(resolve));
		if (!paintText(drafted).includes(draft)) throw new Error("Ctrl+C scenario: draft never reached the screen");
		const costBefore = composer.ui.lastFrameCostMs;
		const pressed = nextPaint(resolve => composer.ui.addPaintListener(resolve));
		const t0 = performance.now();
		terminal.sendInput("\x03");
		const paint = await pressed;
		const t1 = performance.now();
		samples.push(t1 - t0);
		costs.push(costBefore);
		if (paintText(paint).includes(draft)) draftSurvived++;
		exits += fixture.exits.length;
		composer.ui.stop();
	}
	detector.stop();
	return {
		latency: summarize(samples, sessions),
		sessions,
		exits,
		draftSurvived,
		loopBlockedEvents: detector.events.length,
		frameCost: summarize(costs, 0),
	};
}

// ---------------------------------------------------------------------------
// Golden output digest
// ---------------------------------------------------------------------------

/**
 * SHA-256 over every painted row of a fixed operation sequence. A change to the
 * render path that alters emitted output changes this digest, so a later
 * optimisation can be told apart from a rendering regression.
 */
async function goldenDigest(): Promise<string> {
	const fixture = buildFixture({ ...LONG_TRANSCRIPT, turns: 4, bashLines: 200, seed: 7 });
	const { composer, terminal } = fixture;
	const hash = createHash("sha256");
	await settle(terminal, 200);
	// Only the settled viewport after each logical step is absorbed, never every
	// paint. Absorbing each paint would fold the frame *count* into the digest, and
	// the frame count depends on how busy the machine was — so the digest would
	// change when nothing about the rendered output changed, and every run on a
	// contended host would report a false output difference. What this check is for
	// is "did this change alter what is on screen", so it hashes screen states.
	let lastPaint: TuiPaint | undefined;
	const unsubscribe = composer.ui.addPaintListener(paint => {
		lastPaint = paint;
	});
	const step = async (label: string, settleMs: number): Promise<void> => {
		lastPaint = undefined;
		await settle(terminal, settleMs);
		if (lastPaint === undefined) throw new Error(`golden digest: no paint after step ${label}`);
		hash.update(`${label}\n`);
		hash.update(lastPaint.viewport.join("\n"));
	};
	for (const ch of "the quick brown fox") {
		terminal.sendInput(ch);
		await step(`type:${ch}`, 60);
	}
	terminal.resize(100, 30);
	await step("resize:100x30", 120);
	terminal.resize(COLUMNS, ROWS);
	await step(`resize:${COLUMNS}x${ROWS}`, 120);
	for (let i = 0; i < 5; i++) {
		terminal.scrollLines(3);
		composer.ui.requestRender();
		await step(`scroll:${i}`, 60);
	}
	unsubscribe();
	composer.ui.stop();
	return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

interface MemoryCheck {
	/** Heap-used after each fixture build and a forced GC, MiB. */
	seriesMiB: number[];
	baselineHeapMiB: number;
	finalHeapMiB: number;
	deltaMiB: number;
	/** Per-build growth over the last four builds, MiB. A leak is linear; a plateau is not. */
	perBuildMiB: number;
	leak: boolean;
	bandMiB: number;
	note: string;
}

/**
 * The product spec §5.3 per-frame leak check: build the fixture repeatedly, force a
 * full GC after each, and report the whole series rather than only the endpoints.
 *
 * The series is the point. An endpoint-only check cannot distinguish a retained
 * per-frame allocation from a one-off high-water mark that the collector has not
 * returned yet; a linear series is a leak and a flattening series is not. Each
 * build also constructs a `VirtualTerminal`, and that object's kitty WASM engine
 * owns its scrollback, so the series mixes app retention with engine retention —
 * stated in `note` so nobody reads the delta as an app-only figure.
 */
async function memoryLeakCheck(bandMiB: number): Promise<MemoryCheck> {
	const mib = (bytes: number): number => Number((bytes / 1024 / 1024).toFixed(2));
	const spec = { ...LONG_TRANSCRIPT, bashLines: 400, seed: 11 };
	const seriesMiB: number[] = [];
	for (let i = 0; i < 6; i++) {
		const fixture = buildFixture(spec);
		await settle(fixture.terminal, 150);
		fixture.composer.ui.stop();
		Bun.gc(true);
		Bun.gc(true);
		seriesMiB.push(mib(process.memoryUsage().heapUsed));
	}
	const baseline = seriesMiB[0] ?? 0;
	const finalHeap = seriesMiB[seriesMiB.length - 1] ?? 0;
	const tail = seriesMiB.slice(2);
	const perBuild =
		tail.length < 2 ? 0 : Number((((tail[tail.length - 1] ?? 0) - (tail[0] ?? 0)) / (tail.length - 1)).toFixed(2));
	const delta = Number((finalHeap - baseline).toFixed(2));
	return {
		seriesMiB,
		baselineHeapMiB: baseline,
		finalHeapMiB: finalHeap,
		deltaMiB: delta,
		perBuildMiB: perBuild,
		// A per-build slope above the band is a leak; a slope below it is the
		// collector converging, whatever the endpoint delta says.
		leak: perBuild > bandMiB,
		bandMiB,
		note: "each build also constructs a VirtualTerminal, whose kitty WASM engine owns its scrollback",
	};
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const TARGETS: Record<string, { p50: number; p95: number; p99: number; max: number }> = {
	A: { p50: 8, p95: 17, p99: 33, max: 100 },
	B: { p50: 17, p95: 33, p99: 50, max: 100 },
	C: { p50: 33, p95: 50, p99: 100, max: 200 },
	"D-editor-nav": { p50: 33, p95: 67, p99: 100, max: 200 },
	F: { p50: 33, p95: 50, p99: 100, max: 200 },
	G: { p50: 33, p95: 50, p99: 100, max: 100 },
};

/**
 * A row as measured, before the run-to-run band is known.
 *
 * The verdict is deliberately absent: a verdict that depends on whether this pass
 * landed above or below the target cannot be stable across passes, so it is not
 * decided here. `judgeRow` decides it once, from the whole pass set.
 */
interface MeasuredRow {
	/** Row label, `<scenario>@<ms-per-char>`. */
	name: string;
	/** Scenario id from the product spec's §3.1 table. */
	scenario: string;
	description: string;
	intervalMs: number;
	keystrokes: number;
	series: SeriesResult;
	targets: { p50: number; p95: number; p99: number; max: number };
	/** Product spec §4.5 validity gate outcome for this pass. */
	gate: ValidityGate;
	notes: string[];
}

/** A `MeasuredRow` with its cross-pass band and the run's single verdict for it. */
interface ScenarioReport extends MeasuredRow {
	bands: MetricBands;
	verdict: Verdict;
}

/**
 * `unresolvable` is the verdict this task exists to produce.
 *
 * `pass` and `fail` are both claims: one that the row is inside its target, one
 * that it is outside. A verdict that flips between them on identical code is not a
 * measurement, and no reader can adjudicate an improvement against it. When the
 * run-to-run band spans the target, the harness cannot tell which claim is true, so
 * it reports that it cannot tell. That is a distinct answer from `invalid` (the
 * measurement is not comparable at all) and from `fail`.
 */
type Verdict = "pass" | "fail" | "unresolvable" | "invalid";

const METRICS = ["p50", "p95", "p99", "max"] as const;
type Metric = (typeof METRICS)[number];

type MetricBands = { [K in Metric]: Band };

/** Run-to-run spread of one statistic across every pass of the run. */
interface Band {
	/** Passes that contributed a value to this band. */
	passes: number;
	min: number | null;
	median: number | null;
	max: number | null;
	/** `(max - min) / median`, as a percentage. The full spread across passes. */
	spreadPct: number | null;
	/** `spreadPct / 2` — the ± figure to quote next to a median. */
	halfSpreadPct: number | null;
}

function metricValue(summary: Summary, metric: Metric): number | null {
	return summary[metric];
}

/**
 * Spread of one statistic across passes.
 *
 * The product spec §5.3 asks for the noise band to come from repeated runs, so this
 * is where that band is computed. `spreadPct` is the whole peak-to-peak range as a
 * fraction of the median — the number the acceptance threshold is written against —
 * and `halfSpreadPct` is the same quantity halved, because "±24%" is how a band this
 * shape is quoted in prose and reporting only the full width invites a factor-of-two
 * disagreement between two people reading the same run.
 *
 * A single pass has no band: min, max and median collapse onto the one value and
 * `spreadPct` is `null` rather than a flattering zero.
 */
function bandOf(values: readonly (number | null)[]): Band {
	const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
	if (present.length === 0) {
		return { passes: 0, min: null, median: null, max: null, spreadPct: null, halfSpreadPct: null };
	}
	const sorted = [...present].sort((a, b) => a - b);
	const min = sorted[0]!;
	const max = sorted[sorted.length - 1]!;
	const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
	const spreadPct = present.length < 2 || median === 0 ? null : round(((max - min) / median) * 100);
	return {
		passes: present.length,
		min: round(min),
		median: round(median),
		max: round(max),
		spreadPct,
		halfSpreadPct: spreadPct === null ? null : round(spreadPct / 2),
	};
}

function bandsFor(rows: readonly MeasuredRow[]): MetricBands {
	const pick = (metric: Metric): Band => bandOf(rows.map(row => metricValue(row.series.latency, metric)));
	return { p50: pick("p50"), p95: pick("p95"), p99: pick("p99"), max: pick("max") };
}

/** Product spec §4.5 validity gate: the live region the §3.1 target assumes. */
interface ValidityGate {
	met: boolean;
	reasons: string[];
}

/**
 * The product spec §4.5 validity gate, and it gates.
 *
 * §4.5 states its target for a live region still holding 200 settled blocks. This
 * harness runs at a `ROWS`-row viewport, and the transcript container is built to
 * retire blocks into native scrollback once the viewport is full, so at most one
 * settled block per row can be live: a 40-row viewport cannot hold 200 settled
 * blocks whatever the machine does. The precondition is unreachable here by
 * construction, not by measurement noise.
 *
 * A run that fails the gate must not print a confident pass or fail, because its
 * numbers describe a different shape than the target was written for. The gate
 * therefore withholds the verdict (`invalid`) rather than printing `NOT met` under a
 * pass, and states the arithmetic so the `invalid` is attributable to the viewport
 * instead of reading as a mysterious missing precondition.
 */
function validityGate(series: SeriesResult): ValidityGate {
	const reasons: string[] = [];
	if (series.shape.settledMedian < SETTLED_BLOCK_FLOOR) {
		reasons.push(
			`settled median ${series.shape.settledMedian} < ${SETTLED_BLOCK_FLOOR}; at a ${ROWS}-row viewport at most` +
				` ${ROWS} one-row settled blocks can be live, so §4.5's ${SETTLED_BLOCK_FLOOR}-block precondition is` +
				` unreachable on this harness regardless of machine load`,
		);
	}
	if (series.steadyFrameCostMs === 0) reasons.push("steady-state lastFrameCostMs is 0");
	return { met: reasons.length === 0, reasons };
}

/**
 * Judge one row against the product spec §3.1, using the whole pass set.
 *
 * Order matters, and it is the order in which a claim stops being trustworthy:
 *
 * 1. A lost keystroke and a 250 ms loop block are correctness failures. They are
 *    true under any noise level, so they are reported as `fail` rather than
 *    withheld.
 * 2. Percentiles suppressed below the §4.6 minimum, or the §4.5 validity gate not
 *    met, mean the run never produced a comparable measurement — `invalid`, not a
 *    softer `fail`.
 * 3. Otherwise the target comparison is made against the *band*, not against this
 *    pass's value. A target the band clears on every pass is `pass` or `fail`. A
 *    target the band spans is `unresolvable`: the harness has measured that it
 *    cannot tell which side of the line it is on.
 *
 * Because the band is computed once from all passes and the verdict is a function of
 * the band, every pass reports the same verdict for a row by construction. That is
 * what stops B@16 from flipping between `pass`, `fail`, `fail`, `fail`.
 */
function judgeRow(row: MeasuredRow, bands: MetricBands, notes: string[]): Verdict {
	const { series } = row;
	if (series.lostInputs !== 0) {
		notes.push(`${series.lostInputs} keystrokes never reached a paint — a correctness failure, not a latency result`);
		return "fail";
	}
	if (series.loopBlockedEvents > 0) {
		notes.push(`${series.loopBlockedEvents} event-loop blocks over 250 ms`);
		return "fail";
	}
	if (!series.latency.percentilesValid) {
		notes.push(`percentiles suppressed: ${series.latency.count} samples is below the scenario minimum`);
		return "invalid";
	}
	if (!row.gate.met) {
		notes.push(`spec 4.5 validity gate NOT met: ${row.gate.reasons.join("; ")}`);
		return "invalid";
	}
	if (TARGETS[row.scenario] === undefined) return "pass";
	const missed: string[] = [];
	const straddled: string[] = [];
	for (const metric of METRICS) {
		const band = bands[metric];
		const target = row.targets[metric];
		if (band.min === null || band.max === null) continue;
		if (band.min > target) {
			missed.push(`${metric} ${band.min} > ${target} in all ${band.passes} passes`);
		} else if (band.max > target) {
			straddled.push(
				`${metric} band ${band.min}..${band.max} spans the ${target} target` +
					` (±${String(band.halfSpreadPct)}% across ${band.passes} passes)`,
			);
		}
	}
	if (missed.length > 0) {
		notes.push(`exceeds spec 3.1 target: ${missed.join(", ")}`);
		return "fail";
	}
	if (straddled.length > 0) {
		notes.push(`spec 3.1 target not resolvable: ${straddled.join(", ")}`);
		return "unresolvable";
	}
	notes.push(`meets every spec 3.1 target for this row in all ${bands.p50.passes} passes`);
	return "pass";
}

/**
 * Turn every pass's measured rows into reports carrying the same verdict.
 *
 * `runPass` visits the scenarios in a fixed order and never skips one, so row index
 * `i` names the same row in every pass. The band is computed down that column, then
 * the verdict is written back onto every pass, which is why the verdicts agree.
 */
function adjudicate(passes: MeasuredRow[][]): ScenarioReport[][] {
	return passes.map(rows => {
		const bandsPerRow = rows.map((_, index) => bandsFor(passes.map(p => p[index]!)));
		return rows.map((row, index) => {
			const bands = bandsPerRow[index]!;
			const notes = [...row.notes];
			return { ...row, notes, bands, verdict: judgeRow(row, bands, notes) };
		});
	});
}

/** The shape and frame-cost decomposition, reported for every row. */
function describeShape(series: SeriesResult, notes: string[]): void {
	const shape = series.shape;
	notes.push(
		`live region during run: settled median=${shape.settledMedian} min=${shape.settledMin}` +
			` max=${shape.settledMax} over ${shape.samples} samples` +
			` (end: committed=${shape.committedEnd} active=${shape.activeEnd})`,
	);
	notes.push(
		`frame decomposition (ms/frame): total=${series.frameCost.p50} live-blocks=${series.blockMsPerFrame.toFixed(3)}` +
			` of which streaming=${series.streamMsPerFrame.toFixed(3)}` +
			` (${series.streamRendersPerFrame.toFixed(1)} renders @ ${series.streamMsPerRender.toFixed(3)}ms each)` +
			` other-blocks=${series.otherMsPerFrame.toFixed(3)}` +
			` (${series.otherRendersPerFrame.toFixed(1)} renders)` +
			` residual layout+prepare+write=${series.residualMsPerFrame.toFixed(3)}`,
	);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(rows: readonly ScenarioReport[]): void {
	const header = [
		"scenario",
		"n",
		"p50",
		"p95",
		"p99",
		"max",
		"handle",
		"sched",
		"frame",
		"streamMs",
		"otherMs",
		"residMs",
		"fps",
		"coalesced",
		"lost",
		"verdict",
	];
	const body = rows.map(row => {
		const s = row.series;
		const num = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
		return [
			row.name,
			String(s.latency.count),
			num(s.latency.p50),
			num(s.latency.p95),
			num(s.latency.p99),
			num(s.latency.max),
			num(s.inputHandle.p50),
			num(s.scheduleDelay.p50),
			num(s.frameCost.p50),
			s.streamMsPerFrame.toFixed(2),
			s.otherMsPerFrame.toFixed(2),
			s.residualMsPerFrame.toFixed(2),
			s.renderRatePerSecond.toFixed(1),
			String(s.coalescedInputs),
			String(s.lostInputs),
			row.verdict,
		];
	});
	const widths = header.map((cell, i) => Math.max(cell.length, ...body.map(r => r[i]!.length)));
	const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	console.log(line(header));
	console.log(widths.map(w => "-".repeat(w)).join("  "));
	for (const row of body) console.log(line(row));
	console.log("");
	console.log("L = keystroke-to-frame ms. handle = synchronous #handleInput cost.");
	console.log("sched = requestRender hop + cadence/adaptive delay. frame = #doRender cost (one frame lag).");
	console.log("streamMs/otherMs/residMs = per-frame ms inside the live streaming block, inside every");
	console.log("other live transcript block, and in layout+prepare+terminal write respectively.");
}

function printNotes(rows: readonly ScenarioReport[]): void {
	for (const row of rows) {
		for (const note of row.notes) console.log(`  [${row.name}] ${note}`);
	}
}

/**
 * The §5.3 noise band for every row, plus the verdict-agreement check.
 *
 * The band is reported next to the numbers rather than left implicit because a
 * number without its band cannot be held against a threshold: that is the whole
 * reason F@16 could not carry a before-and-after claim at a ±24% band while AC3 is
 * a 30% improvement threshold. Reporting it per row is also what makes a verdict
 * flapping between passes visible as a straddled target instead of as a mystery.
 */
function printBandTable(reports: readonly ScenarioReport[], totalPasses: number): void {
	const header = [
		"scenario",
		"p50 min",
		"p50 med",
		"p50 max",
		"p50 spread",
		"p99 min",
		"p99 med",
		"p99 max",
		"p99 spread",
	];
	const body = reports.map(row => {
		const cells: string[] = [row.name];
		for (const metric of ["p50", "p99"] as const) {
			const band = row.bands[metric];
			const num = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
			cells.push(
				num(band.min),
				num(band.median),
				num(band.max),
				band.spreadPct === null ? "-" : `${band.spreadPct.toFixed(1)}%`,
			);
		}
		return cells;
	});
	const widths = header.map((cell, i) => Math.max(cell.length, ...body.map(r => r[i]!.length)));
	const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	console.log(line(header));
	console.log(widths.map(w => "-".repeat(w)).join("  "));
	for (const row of body) console.log(line(row));
	console.log("");
	console.log(
		`band = run-to-run spread over ${totalPasses} pass(es); spread = (max - min) / median, the full` +
			` peak-to-peak range. A '-' spread means the row had fewer than two passes with a value.`,
	);
}

/**
 * Report whether every pass gave every row the same verdict.
 *
 * This is the acceptance check stated as output rather than asserted by a reader
 * comparing five runs by eye, and it is reported rather than enforced: a disagreement
 * here is a finding about the harness's band, which is exactly what the band is for.
 */
function printVerdictStability(passes: readonly ScenarioReport[][]): void {
	if (passes.length < 2) {
		console.log(`verdict stability: not checked — ${passes.length} pass, no band to make a verdict from`);
		return;
	}
	const unstable: string[] = [];
	for (let index = 0; index < (passes[0]?.length ?? 0); index++) {
		const verdicts = passes.map(rows => rows[index]!.verdict);
		if (new Set(verdicts).size > 1) unstable.push(`${passes[0]![index]!.name} (${verdicts.join("/")})`);
	}
	console.log(
		`verdict stability: ${passes[0]!.length - unstable.length}/${passes[0]!.length} rows gave the same` +
			` verdict in all ${passes.length} passes` +
			(unstable.length === 0 ? "" : ` — DISAGREED: ${unstable.join(", ")}`),
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** One full pass over every scenario except G and E, which have their own drivers. */
async function runPass(options: Options, typingSamples: number): Promise<MeasuredRow[]> {
	const rows: MeasuredRow[] = [];

	// Warm the JIT on the real frame path before any sample is recorded. A fresh
	// process's first keystroke costs an order of magnitude more than the steady
	// state; a benchmark that reports it as the baseline is measuring module
	// loading, not latency.
	{
		const warm = buildFixture({ ...LONG_TRANSCRIPT, turns: 4, bashLines: 100, seed: 99 });
		await runScript(warm, {
			keystrokes: 80,
			intervalMs: 16,
			streamChunkBytes: 0,
			streamEveryMs: 0,
			contentChecked: true,
		});
		warm.composer.ui.stop();
	}

	/**
	 * Row label is `<scenario>@<ms-per-char>`. The spec's §3.1 table gives one row per
	 * scenario and §4.2 gives three typing rates; reporting "A" twice with no rate in
	 * the label would hide the single most important result in the run, which is that
	 * the same scenario at two rates lands on opposite sides of its target.
	 */
	const record = (
		scenario: string,
		intervalMs: number,
		description: string,
		keystrokes: number,
		outcome: RunOutcome,
	): void => {
		const series = seriesFrom(outcome, keystrokes);
		const notes: string[] = [];
		describeShape(series, notes);
		rows.push({
			name: `${scenario}@${intervalMs}`,
			scenario,
			description,
			intervalMs,
			keystrokes,
			series,
			targets: TARGETS[scenario] ?? { p50: 0, p95: 0, p99: 0, max: 0 },
			gate: validityGate(series),
			notes,
		});
	};

	// A — typing into an empty prompt, at the two rates that decide the answer.
	//
	// `#scheduleRender` computes `cadenceDelay = max(0, 1000/30 - elapsed)` on the
	// real clock, so a keystroke arriving 16 ms after the last frame waits a further
	// ~17 ms for the cadence slot, while one arriving 100 ms after it has an expired
	// cadence and only pays the scheduler hop. The spec's row A target (p50 <= 8 ms)
	// is therefore reachable at one typing rate and structurally unreachable at
	// another, with no change to the code in between. Both rates are run so the
	// baseline says which is which, and the row name carries the rate.
	for (const intervalMs of options.quick ? [16] : [16, 50]) {
		const fixture = buildFixture({ ...LONG_TRANSCRIPT, turns: 0, bashLines: 0, seed: 2 });
		record(
			"A",
			intervalMs,
			`typing into an empty prompt (${intervalMs} ms/char)`,
			typingSamples,
			await runScript(fixture, {
				keystrokes: typingSamples,
				intervalMs,
				streamChunkBytes: 0,
				streamEveryMs: 0,
				contentChecked: true,
			}),
		);
		fixture.composer.ui.stop();
	}

	// B — short conversation on screen.
	{
		const fixture = buildFixture({ ...LONG_TRANSCRIPT, turns: 3, bashLines: 40, seed: 3 });
		record(
			"B",
			16,
			"typing, short conversation on screen",
			typingSamples,
			await runScript(fixture, {
				keystrokes: typingSamples,
				intervalMs: 16,
				streamChunkBytes: 0,
				streamEveryMs: 0,
				contentChecked: true,
			}),
		);
		fixture.composer.ui.stop();
	}

	// C — long transcript on screen.
	{
		const fixture = buildFixture(LONG_TRANSCRIPT);
		record(
			"C",
			16,
			"typing, long transcript on screen",
			typingSamples,
			await runScript(fixture, {
				keystrokes: typingSamples,
				intervalMs: 16,
				streamChunkBytes: 0,
				streamEveryMs: 0,
				contentChecked: true,
			}),
		);
		fixture.composer.ui.stop();
	}

	// F — typing while a large tool result streams: the #2081 shape, at the three
	// rates the product spec §4.2 names.
	//
	// Only the 16 ms/char rate gets the full 1,000 samples. The two slower rates are
	// the wall-clock budget's constraint — 1,000 keystrokes at 100 ms/char is 100
	// seconds of nothing but sleeping — so they run at 500. Per spec §4.6 that
	// suppresses their percentiles rather than printing a p99 from a short run;
	// `max` stays valid at any sample count, and it is the number the slower rates
	// are read for.
	for (const [intervalMs, samples] of options.quick
		? ([[16, typingSamples]] as const)
		: ([
				[16, typingSamples],
				[50, typingSamples / 2],
				[100, typingSamples / 2],
			] as const)) {
		const fixture = buildFixture(LONG_TRANSCRIPT);
		const outcome = await runScript(fixture, {
			keystrokes: samples,
			intervalMs,
			streamChunkBytes: LONG_TRANSCRIPT.streamChunkBytes,
			streamEveryMs: intervalMs * 2,
			contentChecked: true,
		});
		const series = seriesFrom(outcome, samples);
		const notes: string[] = [];
		describeShape(series, notes);
		rows.push({
			name: `F@${intervalMs}`,
			scenario: "F",
			description: `typing while a tool result streams (${intervalMs} ms/char)`,
			intervalMs,
			keystrokes: samples,
			series,
			targets: TARGETS.F!,
			gate: validityGate(series),
			notes,
		});
		fixture.composer.ui.stop();
	}

	// D — editor viewport paging and caret navigation. See the file header for why
	// this is not the spec's terminal-scrollback row.
	{
		const fixture = buildFixture(LONG_TRANSCRIPT);
		record(
			"D-editor-nav",
			16,
			"editor paging/caret navigation on the long transcript",
			typingSamples,
			await runScript(fixture, {
				keystrokes: typingSamples,
				intervalMs: 16,
				streamChunkBytes: 0,
				streamEveryMs: 0,
				keys: NAV_KEYS,
				contentChecked: false,
			}),
		);
		fixture.composer.ui.stop();
	}

	return rows;
}

// ---------------------------------------------------------------------------
// Contention
// ---------------------------------------------------------------------------

/**
 * One-minute load average, or `undefined` where `/proc/loadavg` does not exist.
 *
 * A latency benchmark that does not record what else the machine was doing cannot
 * be believed when its numbers move. The product spec §5.3 asks for a noise band
 * derived from repeated runs; this is the other half of that — the band is only
 * interpretable next to the load it was measured under, and a run that shows
 * 250 ms event-loop blocks is telling you the band is contention, not the product.
 */
function loadAverage(): number | undefined {
	try {
		// Synchronous on purpose: this is called from synchronous reporting code, and
		// `Bun.file().text()` is a promise, so the previous version threw a TypeError
		// that the catch turned into `undefined` — the load average was reported as
		// missing on every run while looking like it was being collected.
		const raw = readFileSync("/proc/loadavg", "utf8");
		const value = Number(raw.split(" ")[0]);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runnable CPU count, or `undefined` where `os.cpus()` is unavailable.
 *
 * Recorded next to the load average because a load average is only interpretable
 * against a core count: 25 on a 12-core box is oversubscribed, 25 on a 64-core box
 * is idle. The two numbers together are attributable; either alone is not.
 */
function cpuCount(): number | undefined {
	try {
		const count = os.cpus().length;
		return count > 0 ? count : undefined;
	} catch {
		return undefined;
	}
}

const FULL_SHA = /^[0-9a-f]{40}$/;

interface ResolvedCommit {
	sha: string | null;
	source: "git rev-parse HEAD" | "GIT_COMMIT" | "unresolved";
	/** `GIT_COMMIT` when it was set and disagreed with the checkout, else null. */
	conflictingEnvSha: string | null;
}

/**
 * The commit the measurement actually ran from.
 *
 * `commit: Bun.env.GIT_COMMIT ?? null` was the whole mechanism, and nothing set that
 * variable, so every artifact this harness emitted carried `"commit": null` — the
 * measurement was unattributable to any revision, which makes it impossible to say
 * which code a number came from or whether two numbers are the same code.
 *
 * `git rev-parse HEAD` is read from the checkout at run time and is the default,
 * because it is the revision the harness actually loaded. `GIT_COMMIT` is honoured
 * only as a fallback for a caller that pinned a revision it did not check out, and
 * when both are present and disagree the disagreement is reported rather than
 * silently resolved — a `commit` field that names a revision other than the one
 * measured is worse than a missing one.
 */
function resolveCommit(): ResolvedCommit {
	let fromGit: string | null = null;
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: resolve(import.meta.dir, "..", "..", ".."),
			stdout: "pipe",
			stderr: "ignore",
			timeout: 5_000,
		});
		if (result.exitCode === 0) {
			const sha = result.stdout.toString().trim();
			if (FULL_SHA.test(sha)) fromGit = sha;
		}
	} catch {
		// No git, or not a checkout: reported below as `unresolved`.
	}
	const override = Bun.env.GIT_COMMIT?.trim();
	const fromEnv = override !== undefined && FULL_SHA.test(override) ? override : null;
	const conflicting = fromGit !== null && fromEnv !== null && fromGit !== fromEnv ? fromEnv : null;
	if (fromGit !== null) return { sha: fromGit, source: "git rev-parse HEAD", conflictingEnvSha: conflicting };
	if (fromEnv !== null) return { sha: fromEnv, source: "GIT_COMMIT", conflictingEnvSha: null };
	return { sha: null, source: "unresolved", conflictingEnvSha: null };
}

// ---------------------------------------------------------------------------
// Projection: what frame cost each candidate change would buy
// ---------------------------------------------------------------------------

interface Projection {
	scenario: string;
	intervalMs: number;
	measuredP99: number;
	measuredFrameCostMs: number;
	measuredRendersPerFrame: number;
	measuredMsPerRender: number;
	/** Frame cost if the frame rendered each live block exactly once. */
	dedupFrameCostMs: number;
	/** Projected L p99 from the dedup alone, under the measured scheduling law. */
	dedupP99: number;
	/** True when the measured frame cost already meets the row's p99 target. */
	targetAlreadyMet: boolean;
	/**
	 * Largest frame cost the row's p99 target can afford, i.e. the budget the work
	 * has to fit inside.
	 */
	maxAffordableFrameCostMs: number;
	dedupMeetsTarget: boolean;
}

/**
 * Project what a cheaper frame would buy, using the scheduling law the code
 * actually implements.
 *
 * `#scheduleRender` fires after `max(cadenceDelay, adaptiveDelay, inputGraceDelay)`
 * where `cadenceDelay = max(0, 1000/30 - elapsed)` and
 * `adaptiveDelay = max(0, min(200, 2 * lastFrameCostMs) - elapsed)`, and `elapsed`
 * is the time since the last frame started. So `L` is bounded below by
 * `handle + max(33.3 - elapsed, min(200, 2 * frameCost) - elapsed) + frameCost`.
 *
 * Two consequences the naive "halve the frame cost, halve the latency" reading gets
 * wrong, and which the numbers below make explicit:
 *
 * 1. While a frame costs more than one cadence period, `min(200, 2 * frameCost)`
 *    is the binding term, so latency falls with `3 x frameCost`, not `2 x`.
 * 2. `#MAX_ADAPTIVE_RENDER_MS` caps that term at 200 ms, so a frame costing more
 *    than 100 ms cannot push the scheduler delay below 200 ms no matter what —
 *    which is why a large frame-cost cut alone leaves the p99 far above target.
 *
 * `elapsed` is taken as the typing interval, clamped to one cadence period, which
 * is the steady-state value at a fixed typing rate. This is arithmetic on the
 * harness's own measured terms: an estimate of what a change is worth before it is
 * written. It is not a before/after measurement and nothing here has been changed.
 */
function projectFrameCost(row: ScenarioReport, target: Projection["frameCostForTargetMs"]): Projection | null {
	const s = row.series;
	const handle = s.inputHandle.p50 ?? 0;
	const elapsed = Math.min(row.intervalMs, 1000 / 30);
	const law = (frameCost: number): number => {
		const cadence = Math.max(0, 1000 / 30 - elapsed);
		const adaptive = Math.max(0, Math.min(200, frameCost * 2) - elapsed);
		return handle + Math.max(cadence, adaptive) + frameCost;
	};
	const measuredFrameCost = s.frameCost.p50 ?? Number.NaN;
	if (!Number.isFinite(measuredFrameCost)) return null;
	// The dedup changes only the block-render term; residual layout/prepare/write
	// and every other live block are held at their measured values.
	const dedupFrameCost = round(
		s.residualMsPerFrame + s.otherMsPerFrame + s.streamMsPerRender * (s.streamRendersPerFrame > 1 ? 1 : 0),
	);
	// The *largest* frame cost the row's p99 target can afford, which is the number
	// that bounds the work. Asking for the smallest affordable frame cost instead
	// returns the search floor and tells the reader nothing: with the cadence term in
	// play, almost any frame cheap enough to be interesting already meets the target,
	// so the answer would be "0.5 ms" whatever the row. When the measured frame cost
	// already meets the target there is no budget to state, so that is reported
	// instead of a number.
	const meetsAtMeasured = law(measuredFrameCost) <= target;
	let maxAffordableFrameCost = Number.NaN;
	for (let candidate = 0.5; candidate <= 400; candidate += 0.5) {
		if (law(candidate) <= target) maxAffordableFrameCost = candidate;
	}
	const dedupP99 = dedupFrameCost > 0 ? round(law(dedupFrameCost)) : Number.NaN;
	return {
		scenario: row.name,
		intervalMs: row.intervalMs,
		measuredP99: s.latency.p99 ?? Number.NaN,
		measuredFrameCostMs: round(measuredFrameCost),
		measuredRendersPerFrame: s.streamRendersPerFrame,
		measuredMsPerRender: s.streamMsPerRender,
		dedupFrameCostMs: dedupFrameCost,
		dedupP99,
		maxAffordableFrameCostMs: maxAffordableFrameCost,
		targetAlreadyMet: meetsAtMeasured,
		dedupMeetsTarget: Number.isFinite(dedupP99) && dedupP99 <= target,
	};
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

interface AmplifierProbe {
	terminalRows: number;
	blocksAdded: number;
	settledBlocks: number;
	committedBlocks: number;
	frames: number;
	blockRendersPerFrame: number;
	/** Renders per *settled* (live, re-rendered-every-frame) block per frame. */
	rendersPerSettledBlock: number;
	frameCostMs: Summary;
	blockMsPerFrame: number;
}

/**
 * Direct test of the amplifier described in `docs/tui-runtime-internals.md:51`.
 *
 * The document says `beginFrame`, `peekFinalizedBatch`, `liveRowCount` and
 * `renderViewport` each render the live blocks inside one frame. The
 * `TranscriptContainer` source claims a `#measuredRows` memo makes the first
 * measurement of each block the only one. This probe builds a transcript of
 * one-row blocks in a viewport tall enough that the settled region is not under
 * capacity pressure — the exact shape the document describes — and counts
 * `render()` calls per frame against the number of settled blocks. A ratio of
 * 1.0 refutes the amplifier; a ratio near 2-4 confirms it. This is the product
 * spec §8.2 question answered with a number rather than an opinion.
 */
async function probeAmplifier(): Promise<AmplifierProbe> {
	const terminalRows = 300;
	const blocks = 256; // MAX_LIVE_BLOCKS
	const terminal = new VirtualTerminal(COLUMNS, terminalRows, SCROLLBACK);
	const composer = new Composer({
		terminal,
		tuiOptions: { onPaint: () => {} },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		exit: () => {},
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < blocks; i++) {
		transcript.addChild(new ProbedBlock(new Text(`block ${i}`, 0, 0), 1, true));
	}
	composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
	composer.ui.setFocus(composer.editor);
	composer.start({});
	await settle(terminal, 800);

	frameRenders.calls = 0;
	frameRenders.nanos = 0;
	frameRenders.streamCalls = 0;
	frameRenders.streamNanos = 0;
	frameRenders.otherCalls = 0;
	frameRenders.otherNanos = 0;
	const costs: number[] = [];
	const blockMs: number[] = [];
	const renderCalls: number[] = [];
	const unsubscribe = composer.ui.addPaintListener(() => {
		costs.push(composer.ui.lastFrameCostMs);
		blockMs.push(frameRenders.nanos / 1e6);
		renderCalls.push(frameRenders.calls);
		frameRenders.calls = 0;
		frameRenders.nanos = 0;
		frameRenders.otherCalls = 0;
		frameRenders.otherNanos = 0;
	});
	for (let i = 0; i < 30; i++) {
		composer.ui.requestRender();
		await settle(terminal, 50);
	}
	unsubscribe();
	let settled = 0;
	let committed = 0;
	for (const state of transcript.blockStates()) {
		if (state === "settled") settled++;
		else if (state === "committed") committed++;
	}
	composer.ui.stop();

	// Drop the first frames: they include the container's one-off width/index
	// setup, which is not the steady-state per-frame shape under test.
	const steady = renderCalls.slice(5);
	const perFrame = steady.length === 0 ? 0 : steady.reduce((a, b) => a + b, 0) / steady.length;
	const steadyBlockMs = blockMs.slice(5);
	return {
		terminalRows,
		blocksAdded: blocks,
		settledBlocks: settled,
		committedBlocks: committed,
		frames: steady.length,
		blockRendersPerFrame: round(perFrame),
		rendersPerSettledBlock: settled === 0 ? 0 : round(perFrame / settled),
		frameCostMs: summarize(costs.slice(5), 0),
		blockMsPerFrame: round(steadyBlockMs.reduce((a, b) => a + b, 0) / Math.max(1, steadyBlockMs.length)),
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));

	// Multiplexer detection reads the environment and would otherwise change the
	// terminal capability set between a developer's shell and CI.
	for (const key of [
		"TMUX",
		"STY",
		"ZELLIJ",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
		"WMUX",
		"WMUX_SURFACE_ID",
		"TERM",
	]) {
		delete Bun.env[key];
	}
	await initTheme();

	const typingSamples = options.quick ? 120 : 1000;
	const streamChunks = options.quick ? 20 : 100;
	const ctrlCSessions = options.quick ? 12 : 100;
	const loadAtStart = loadAverage();
	const cores = cpuCount();
	const commit = resolveCommit();
	const started = performance.now();

	// `--quick` runs a different experiment at different sample counts, and a quick
	// F@16 p50 lands around 56-114 ms against a full run's ~90-130 ms purely because
	// 120 samples never reach the tail and the streaming block never grows. Stating
	// that in band is the difference between a smoke check and a mis-pasted
	// baseline, so it is printed before any number this run produces, and it is a
	// hard header rather than a trailing footnote nobody reads.
	const comparability = options.quick
		? {
				comparable: false,
				reason:
					"--quick: smoke-sized sample counts (120 keystrokes/row, 20 stream chunks, 12 Ctrl+C sessions)" +
					" over a shorter transcript than a full pass builds. Sample counts, percentiles, verdicts and" +
					" projections from this run are NOT comparable to a full run and must not be pasted as one.",
			}
		: { comparable: true, reason: null };
	if (!comparability.comparable) {
		console.log("=".repeat(100));
		console.log(`!! ${comparability.reason}`);
		console.log("=".repeat(100));
		console.log("");
	}

	const measured: MeasuredRow[][] = [];
	const passLoad: { start: number | null; end: number | null }[] = [];
	for (let repeat = 0; repeat < options.repeats; repeat++) {
		// Load is recorded per pass, not once per run. The §5.3 noise band is only
		// interpretable next to the conditions each pass ran under: a run-wide
		// average cannot tell a reader whether one pass was quiet and the next was
		// descheduled, and that distinction is the whole question when a p99 moves
		// by 100% between passes.
		const start = loadAverage();
		measured.push(await runPass(options, typingSamples));
		passLoad.push({ start: start ?? null, end: loadAverage() ?? null });
	}
	// Every pass's verdict is decided from the band across all passes, so the five
	// runs of an identical checkout report one verdict per row instead of five.
	const passes = adjudicate(measured);
	for (let i = 0; i < passes.length; i++) {
		const blocked = passes[i]!.reduce((total, row) => total + row.series.loopBlockedEvents, 0);
		console.log(
			`pass ${i + 1}/${passes.length}: 1-minute load average ${String(passLoad[i]!.start)} ->` +
				` ${String(passLoad[i]!.end)} on ${String(cores)} runnable cores, ${blocked} event-loop blocks over 250 ms` +
				(blocked === 0 ? "" : " — percentiles for this pass are an upper bound, not a baseline"),
		);
	}

	// Scenario G — Ctrl+C, one press per session.
	const ctrlC = await runCtrlC(ctrlCSessions, 40);

	// Scenario E — result-to-first-paint on a >200 KB tool result.
	const streamFixture = buildFixture({ ...LONG_TRANSCRIPT, turns: 10, bashLines: 0, seed: 6 });
	const stream = await runStream(streamFixture, streamChunks, 8192);
	streamFixture.composer.ui.stop();

	const digest = await goldenDigest();
	const memory = await memoryLeakCheck(4);
	const amplifier = options.diagnostics ? await probeAmplifier() : null;

	const primary = passes[0] ?? [];
	printTable(primary);
	printBandTable(primary, passes.length);
	printVerdictStability(passes);
	printNotes(primary);
	console.log("");
	console.log(
		`E (L_stream, result-to-first-paint): n=${stream.latency.count} chunks=${stream.chunks}` +
			` bytes=${stream.totalBytes} p50=${String(stream.latency.p50)} p95=${String(stream.latency.p95)}` +
			` p99=${String(stream.latency.p99)} max=${stream.latency.max} loopBlocked=${stream.loopBlockedEvents}`,
	);
	console.log(
		`G (Ctrl+C): sessions=${ctrlC.sessions} p50=${String(ctrlC.latency.p50)} p95=${String(ctrlC.latency.p95)}` +
			` p99=${String(ctrlC.latency.p99)} max=${ctrlC.latency.max} target p99<=${TARGETS.G!.p99}` +
			` exits=${ctrlC.exits} draftSurvived=${ctrlC.draftSurvived} loopBlocked=${ctrlC.loopBlockedEvents}`,
	);
	console.log(
		`memory: heap-used after each of 6 fixture builds + forced GC (MiB):` +
			` ${memory.seriesMiB.join(", ")} | endpoint delta=${memory.deltaMiB}MiB` +
			` per-build slope=${memory.perBuildMiB}MiB leak=${memory.leak} band=${memory.bandMiB}MiB`,
	);
	console.log(`memory note: ${memory.note}`);
	if (amplifier !== null) {
		console.log(
			`amplifier probe (docs/tui-runtime-internals.md:51): ${amplifier.blocksAdded} one-row blocks in a` +
				` ${amplifier.terminalRows}-row viewport; settled=${amplifier.settledBlocks}` +
				` committed=${amplifier.committedBlocks}; over ${amplifier.frames} steady frames` +
				` render() calls/frame=${amplifier.blockRendersPerFrame.toFixed(1)}` +
				` = ${amplifier.rendersPerSettledBlock.toFixed(2)}x per settled block;` +
				` frame p50=${String(amplifier.frameCostMs.p50)}ms, block render ms/frame=${amplifier.blockMsPerFrame}`,
		);
	}
	// A projection is the most pasteable artifact this harness emits: it reads as
	// "make the frame this cheap and the target is met". Under `--quick` that
	// sentence would be arithmetic on 120 samples and a transcript a tenth the size,
	// so the whole block is suppressed rather than caveated. Suppression, not a
	// warning, is what makes a quick number impossible to mistake for a full one.
	if (!comparability.comparable) {
		console.log(
			`projection: SUPPRESSED — ${comparability.reason} The projection is arithmetic on this run's` +
				` measured terms, so a --quick projection would state a full-run conclusion from smoke-sized samples.`,
		);
	} else {
		for (const row of primary) {
			const target = TARGETS[row.scenario]?.p99;
			if (target === undefined) continue;
			const projection = projectFrameCost(row, target);
			if (projection === null) continue;
			const requirement = projection.targetAlreadyMet
				? `the p99<=${target}ms target is already met at that frame cost, so latency here is cadence-bound, not work-bound`
				: `the p99<=${target}ms target affords a frame of at most` +
					` ${projection.maxAffordableFrameCostMs}ms, so the frame must come down from` +
					` ${projection.measuredFrameCostMs}ms`;
			console.log(
				`projection [${row.name} @${row.intervalMs}ms/char]: ${requirement}.` +
					` Rendering each live block once per frame instead of` +
					` ${projection.measuredRendersPerFrame.toFixed(2)}x gives ${projection.dedupFrameCostMs}ms` +
					` -> p99 ${projection.dedupP99}ms, which ${projection.dedupMeetsTarget ? "meets" : "does NOT meet"}` +
					` the target. Measured-term arithmetic, not a before/after measurement.`,
			);
		}
	}
	console.log(`golden viewport digest: ${digest}`);

	const elapsedSeconds = round((performance.now() - started) / 1000);
	const loadAtEnd = loadAverage();
	const loopBlockedTotal =
		primary.reduce((total, row) => total + row.series.loopBlockedEvents, 0) +
		stream.loopBlockedEvents +
		ctrlC.loopBlockedEvents;
	console.log(
		`run wall clock: ${elapsedSeconds}s over ${passes.length} pass(es);` +
			` 1-minute load average ${String(loadAtStart)} -> ${String(loadAtEnd)} on ${String(cores)} runnable cores;` +
			` ${loopBlockedTotal} event-loop blocks over 250 ms across the run` +
			(loopBlockedTotal > 0
				? " — the machine was descheduling this process, so the percentiles above are an upper bound, not a baseline"
				: ""),
	);
	// The commit is reported on stdout as well as in the JSON. An artifact that
	// cannot be attributed to a revision cannot be compared with another artifact,
	// and the run summary is the part of the output that gets pasted into an issue.
	console.log(
		`commit: ${commit.sha ?? "UNRESOLVED"} (source: ${commit.source})` +
			(commit.conflictingEnvSha === null
				? ""
				: ` — WARNING: GIT_COMMIT=${commit.conflictingEnvSha} disagrees with the checkout measured`),
	);
	if (commit.sha === null) {
		console.log(
			"commit WARNING: no SHA resolved, so this run's numbers are not attributable to any revision." +
				" 'git rev-parse HEAD' failed and GIT_COMMIT was unset or malformed.",
		);
	}

	if (options.jsonPath !== undefined) {
		const json = {
			schema: "tui-keystroke-latency/1",
			commit: commit.sha,
			commitSource: commit.source,
			commitConflictingEnvSha: commit.conflictingEnvSha,
			bun: Bun.version,
			platform: `${process.platform}-${process.arch}`,
			terminal: { columns: COLUMNS, rows: ROWS, scrollback: SCROLLBACK },
			quick: options.quick,
			comparableToFullRun: comparability.comparable,
			comparabilityReason: comparability.reason,
			repeats: passes.length,
			elapsedSeconds,
			loadAverage: {
				start: loadAtStart ?? null,
				end: loadAtEnd ?? null,
				cores: cores ?? null,
				loopBlockedEvents: loopBlockedTotal,
				perPass: passLoad,
			},
			goldenViewportDigestSha256: digest,
			ctrlC,
			stream,
			memory,
			amplifier,
			projections: comparability.comparable
				? primary
						.map(row => {
							const target = TARGETS[row.scenario]?.p99;
							return target === undefined ? null : projectFrameCost(row, target);
						})
						.filter(item => item !== null)
				: [],
			scenarios: primary,
			allPasses: passes,
		};
		await Bun.write(options.jsonPath, `${JSON.stringify(json, null, 2)}\n`);
		console.log(`JSON written to ${options.jsonPath}`);
	}
}

await main();
