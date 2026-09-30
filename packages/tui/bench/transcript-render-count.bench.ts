/**
 * Per-frame transcript render count and cost, on the production block
 * population, under real keystroke traffic.
 *
 * `transcript-block-reshapes.test.ts` measures the same thing from a synthetic
 * composition: one `beginFrame` plus one `renderViewport`, counting the
 * container's own `render` calls on the real classes. That answers "what does
 * one frame do to one block". It does not answer "what does a frame cost while
 * somebody types", because a real frame is a composition whose shape depends on
 * the live tail, the retirement pressure and the reservation the allocator
 * hands each block, none of which a synthetic composition reproduces.
 *
 * So this file drives the real stdin path (`VirtualTerminal.sendInput` ->
 * `terminal.start(onInput)` -> `TUI.#handleInput`) with a transcript built from
 * the production classes the audit named, and reports, per painted frame:
 *
 * - the container's own `render` calls, split per class;
 * - how many blocks the frame actually painted, so the count is also a ratio;
 * - the nanoseconds those calls cost, against the frame's own cost;
 * - keystroke-to-frame wall time, so the count is read next to the thing it is
 *   supposed to be a proxy for.
 *
 * Run: `bun run packages/tui/bench/transcript-render-count.bench.ts` (add
 * `--json <path>` to keep the per-scenario series).
 */

import { ToolExecutionComponent } from "../src/chat/tool-execution";
import { CollabQrCodeComponent } from "../src/chrome/collab-qrcode";
import { MessageDividerComponent } from "../src/chrome/message-divider";
import { TranscriptContainer, type TranscriptStableRow } from "../src/chrome/transcript-container";
import { Text } from "../src/components/text";
import { COMPOSER_DEFAULTS, Composer } from "../src/prompt/composer";
import { initTheme } from "../src/theme";
import type { Component, TuiPaint } from "../src/tui";
import { VirtualTerminal } from "../test/virtual-terminal";

// ---------------------------------------------------------------------------
// Deterministic text
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
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
];

function prose(random: () => number, chars: number): string {
	const out: string[] = [];
	let n = 0;
	while (n < chars) {
		const word = WORDS[Math.floor(random() * WORDS.length)]!;
		out.push(word);
		n += word.length + 1;
	}
	return out.join(" ");
}

function noiseLines(random: () => number, lines: number, columns: number): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const id = String(i).padStart(6, " ");
		out.push(`${id} | ${prose(random, Math.max(8, columns - 12))}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

interface ClassSlot {
	calls: number;
	nanos: number;
}

/**
 * Per-frame counters, reset by the paint listener.
 *
 * `beginFrame` is opened by the container inside `#doRender` and the paint
 * listener runs after `terminal.write`, so everything counted between two
 * listener calls is work the container did for that one frame, including any
 * retirement peek that preceded the viewport. That is deliberate: the question
 * is what a frame costs, not what `renderViewport` alone costs.
 */
const frameCounters = {
	calls: 0,
	nanos: 0,
	byClass: new Map<string, ClassSlot>(),
};

function resetFrameCounters(): void {
	frameCounters.calls = 0;
	frameCounters.nanos = 0;
	frameCounters.byClass.clear();
}

function slot(kind: string): ClassSlot {
	let entry = frameCounters.byClass.get(kind);
	if (entry === undefined) {
		entry = { calls: 0, nanos: 0 };
		frameCounters.byClass.set(kind, entry);
	}
	return entry;
}

/**
 * Count the container's calls to one block's `render`, with the class it belongs
 * to. The wrapper is an own property, so it intercepts the container's dispatch
 * and nothing else: the block's internals are untouched and the rows it paints
 * are the rows the audit tested.
 */
function spy<T extends Component>(component: T, kind: string): T {
	const target = component as { render: (width: number) => readonly string[] };
	const original = target.render.bind(component);
	target.render = (width: number): readonly string[] => {
		const started = Bun.nanoseconds();
		frameCounters.calls++;
		const bucket = slot(kind);
		bucket.calls++;
		try {
			return original(width);
		} finally {
			const elapsed = Bun.nanoseconds() - started;
			frameCounters.nanos += elapsed;
			bucket.nanos += elapsed;
		}
	};
	return component;
}

// ---------------------------------------------------------------------------
// Fixture: the audited production population
// ---------------------------------------------------------------------------

/** An append-only live block that grows, i.e. the tail that forces a squeeze. */
class GrowingTail implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	readonly #text: Text;
	#buffer = "";
	#lastWidth = -1;
	#lastRows: readonly string[] | undefined;

	constructor(text: Text) {
		this.#text = text;
	}

	get isStream(): boolean {
		return true;
	}

	invalidate(): void {
		this.#text.invalidate();
	}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [];
	}

	/**
	 * Real append-only blocks serve their stable rows from their own ledger cache
	 * and never re-render for them. This does the same against its last render, so
	 * the probe does not inflate the render count it exists to measure.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (this.#lastWidth !== width || this.#lastRows === undefined) this.render(width);
		return (this.#lastRows ?? []).slice(0, count);
	}

	append(chunk: string, index: number): void {
		this.#buffer += `${chunk}\nchunk${String(index).padStart(4, "0")}end\n`;
		this.#text.setText(this.#buffer);
	}

	render(width: number): readonly string[] {
		const started = Bun.nanoseconds();
		frameCounters.calls++;
		const bucket = slot("GrowingTail");
		bucket.calls++;
		try {
			const rows = this.#text.render(width);
			this.#lastWidth = width;
			this.#lastRows = rows;
			return rows;
		} finally {
			const elapsed = Bun.nanoseconds() - started;
			frameCounters.nanos += elapsed;
			bucket.nanos += elapsed;
		}
	}
}

const COLUMNS = 120;
const ROWS = 40;
const SCROLLBACK = 200_000;
const TOOL_UI = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };

/**
 * A settled tool card with a tall, stable result: the block that reshapes.
 *
 * `inFlight` decides whether the card is a running tool or a finished one. A
 * finished tool card is sealed into native scrollback and leaves the live
 * region within a frame or two, so the audited population is only measurable
 * while the cards are still running — which is also the state where a user is
 * typing, because a tool that has already returned is not waiting on anything.
 */
function toolCard(height: number, inFlight: boolean): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		{ command: "true" },
		{ useBuiltInRenderer: false },
		undefined,
		TOOL_UI,
		process.cwd(),
	);
	component.updateResult(
		{
			content: [
				{
					type: "text",
					text: Array.from(
						{ length: height },
						(_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(60)}`,
					).join("\n"),
				},
			],
		},
		inFlight,
	);
	return component;
}

interface FixtureSpec {
	/** In-flight tool cards on screen: the population that reshapes. */
	liveTools: number;
	/** Rows each in-flight tool card wants. */
	toolHeight: number;
	/** Finished turns behind them, which retire into native scrollback. */
	retiredTurns: number;
	/** Rows of streaming tail output per append. */
	streamLines: number;
	seed: number;
}

interface Fixture {
	composer: Composer;
	terminal: VirtualTerminal;
	transcript: TranscriptContainer;
	tail: GrowingTail;
	blocks: Component[];
}

function buildFixture(spec: FixtureSpec): Fixture {
	const random = mulberry32(spec.seed);
	const terminal = new VirtualTerminal(COLUMNS, ROWS, SCROLLBACK);
	const composer = new Composer({
		terminal,
		tuiOptions: { onPaint: () => {} },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		exit: () => {},
	});
	const transcript = new TranscriptContainer();
	const blocks: Component[] = [];
	const add = (block: Component, kind: string): void => {
		blocks.push(spy(block, kind));
		transcript.addChild(block);
	};

	// History: finished turns. These retire into native scrollback and are what
	// makes the session's scrollback long without making its live region tall.
	for (let turn = 0; turn < spec.retiredTurns; turn++) {
		add(new MessageDividerComponent({ label: () => `turn ${turn}`, labelColor: "accent" }), "MessageDivider");
		add(new Text(prose(random, 240), 0, 0), "Text(user)");
		add(toolCard(spec.toolHeight, false), "ToolExecution(settled)");
		add(new Text(prose(random, 900), 0, 0), "Text(assistant)");
	}

	// The live region: running tool cards, the one non-tool reshaping block, and
	// the growing tail. This is the population SHI-70 audited, on screen, while
	// the user types.
	for (let i = 0; i < spec.liveTools; i++) {
		add(toolCard(spec.toolHeight, true), "ToolExecution(live)");
	}
	add(new MessageDividerComponent({ label: () => "live", labelColor: "accent" }), "MessageDivider");
	add(new Text(prose(random, 600), 0, 0), "Text(assistant)");
	add(new CollabQrCodeComponent("https://my.omp.sh/#full-control"), "CollabQrCode");

	const tail = new GrowingTail(new Text("", 0, 0));
	tail.append(noiseLines(mulberry32(0x5eed), spec.streamLines, 80), 0);
	add(tail, "GrowingTail");

	composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
	composer.ui.setFocus(composer.editor);
	composer.start({});
	return { composer, terminal, transcript, tail, blocks };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[index]!;
}

interface Stat {
	n: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

function stat(values: readonly number[]): Stat {
	if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	return {
		n: sorted.length,
		mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
		p50: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		p99: round(percentile(sorted, 0.99)),
		max: round(sorted[sorted.length - 1]!),
	};
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const TYPED = ((): string => {
	const random = mulberry32(0x5eed);
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	let out = "";
	for (let i = 0; i < 200; i++) out += alphabet[Math.floor(random() * alphabet.length)]!;
	return out;
})();

interface FrameRecord {
	paintedBlocks: number;
	calls: number;
	nanos: number;
	byClass: Record<string, { calls: number; nanos: number }>;
	frameCostMs: number;
}

interface RunResult {
	name: string;
	frames: number;
	keystrokes: number;
	lost: number;
	coalesced: number;
	painted: Stat;
	calls: Stat;
	callsPerPaintedBlock: Stat;
	blockMs: Stat;
	frameCost: Stat;
	residualMs: Stat;
	latency: Stat;
	scheduleDelay: Stat;
	inputHandle: Stat;
	byClass: Record<string, { callsPerFrame: number; msPerFrame: number; frames: number }>;
	extraRenders: { mean: number; p95: number; max: number };
	settled: number;
	committed: number;
	active: number;
	modes: Record<string, number>;
}

/** The paint a keystroke's effect landed in, matched on content, never on order. */
function paintText(paint: TuiPaint): string {
	let out = "";
	for (const row of paint.viewport) out += Bun.stripANSI(row);
	return out.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼ \t\r\n]/g, "");
}

async function settle(terminal: VirtualTerminal, ms = 200): Promise<void> {
	await terminal.waitForRender();
	await Bun.sleep(ms);
	await terminal.flush();
}

async function run(name: string, spec: FixtureSpec, keystrokes: number, intervalMs: number): Promise<RunResult> {
	const { composer, terminal, transcript, tail } = buildFixture(spec);
	await settle(terminal, 300);

	const records: FrameRecord[] = [];
	const samples: { L: number; inputHandle: number; paintIndex: number }[] = [];
	const pending: { t0: number; handleEnd: number; expected: string }[] = [];
	let coalesced = 0;
	let resolved = 0;
	resetFrameCounters();

	// The listener runs inside `#doRender` after `terminal.write`, so the
	// counters it reads are the frame that just painted. `lastFrameCostMs` is
	// the *previous* frame's cost, which is why the pairing below shifts by one.
	const frameCosts: number[] = [];
	const unsubscribe = composer.ui.addPaintListener((paint: TuiPaint) => {
		const at = performance.now();
		const byClass: Record<string, { calls: number; nanos: number }> = {};
		for (const [kind, bucket] of frameCounters.byClass) byClass[kind] = { calls: bucket.calls, nanos: bucket.nanos };
		records.push({
			paintedBlocks: transcript.getLastViewportSpans().length,
			calls: frameCounters.calls,
			nanos: frameCounters.nanos,
			byClass,
			frameCostMs: Number.NaN,
		});
		frameCosts.push(composer.ui.lastFrameCostMs);
		resetFrameCounters();

		let keep = 0;
		const seen = paintText(paint);
		for (let i = 0; i < pending.length; i++) {
			const entry = pending[i]!;
			if (entry.expected.length === 0 || !seen.includes(entry.expected)) {
				pending[keep++] = entry;
				continue;
			}
			samples.push({
				L: at - entry.t0,
				inputHandle: entry.handleEnd - entry.t0,
				paintIndex: records.length - 1,
			});
		}
		pending.length = keep;
		const done = keystrokes - pending.length;
		if (done > resolved + 1) coalesced += done - resolved - 1;
		resolved = done;
	});

	const started = performance.now();
	const streamEvery = Math.max(1, Math.round((intervalMs * 2) / intervalMs));
	let chunks = 0;
	let typed = "";
	for (let i = 0; i < keystrokes; i++) {
		const due = started + i * intervalMs;
		const wait = due - performance.now();
		if (wait > 0.5) await Bun.sleep(wait);
		if (i > 0 && i % streamEvery === 0) {
			tail.append(noiseLines(mulberry32(0xb000 + i), spec.streamLines, 80), chunks++);
			composer.ui.requestRender();
		}
		const data = TYPED[i % TYPED.length]!;
		typed += data;
		pending.push({ t0: performance.now(), handleEnd: Number.NaN, expected: typed });
		terminal.sendInput(data);
		pending[pending.length - 1]!.handleEnd = performance.now();
	}
	await settle(terminal, 400);
	const lost = pending.length;
	pending.length = 0;
	const finalFrameCost = composer.ui.lastFrameCostMs;
	unsubscribe();
	composer.ui.stop();

	// Pair each record with the cost of the frame it painted, then decompose L
	// the way the committed harness does: L = handle + schedule + frame, where
	// the schedule term is everything the render scheduler and the frame cadence
	// add on top of the handler and the work itself.
	const frameCost: number[] = [];
	for (let i = 0; i < records.length; i++) {
		const next = frameCosts[i + 1];
		const cost = next === undefined ? finalFrameCost : next!;
		records[i]!.frameCostMs = cost;
		frameCost.push(cost);
	}
	const latencies: number[] = [];
	const handles: number[] = [];
	const scheduleDelay: number[] = [];
	for (const sample of samples) {
		latencies.push(sample.L);
		handles.push(sample.inputHandle);
		const cost = records[sample.paintIndex]?.frameCostMs ?? finalFrameCost;
		const delay = sample.L - sample.inputHandle - cost;
		scheduleDelay.push(delay > 0 ? delay : 0);
	}

	const painted = records.map(record => record.paintedBlocks);
	const calls = records.map(record => record.calls);
	const perBlock = records.map(record => (record.paintedBlocks === 0 ? 0 : record.calls / record.paintedBlocks));
	const blockMs = records.map(record => record.nanos / 1e6);
	const residual = records.map(record => Math.max(0, record.frameCostMs - record.nanos / 1e6));

	const classes = new Map<string, { calls: number; nanos: number; frames: number }>();
	for (const record of records) {
		for (const [kind, bucket] of Object.entries(record.byClass)) {
			const entry = classes.get(kind) ?? { calls: 0, nanos: 0, frames: 0 };
			entry.calls += bucket.calls;
			entry.nanos += bucket.nanos;
			entry.frames++;
			classes.set(kind, entry);
		}
	}
	const byClass: Record<string, { callsPerFrame: number; msPerFrame: number; frames: number }> = {};
	for (const [kind, entry] of classes) {
		byClass[kind] = {
			callsPerFrame: round(entry.calls / Math.max(1, records.length)),
			msPerFrame: round(entry.nanos / 1e6 / Math.max(1, records.length)),
			frames: entry.frames,
		};
	}

	// A frame that renders more than one call per painted block is spending
	// second renders on the squeeze. This is the number T3's "one render per
	// frame" cannot go below, and it is bounded by the reshaping population, not
	// by the transcript's length.
	const extra = records.map(record => Math.max(0, record.calls - record.paintedBlocks));

	let settled = 0;
	let committed = 0;
	let active = 0;
	for (const state of transcript.blockStates()) {
		if (state === "settled") settled++;
		else if (state === "committed") committed++;
		else active++;
	}
	const modes: Record<string, number> = {};
	for (const mode of transcript.blockModes()) modes[mode] = (modes[mode] ?? 0) + 1;

	return {
		name,
		frames: records.length,
		keystrokes,
		lost,
		coalesced,
		painted: stat(painted),
		calls: stat(calls),
		callsPerPaintedBlock: stat(perBlock),
		blockMs: stat(blockMs),
		frameCost: stat(frameCost),
		residualMs: stat(residual),
		latency: stat(latencies),
		scheduleDelay: stat(scheduleDelay),
		inputHandle: stat(handles),
		byClass,
		extraRenders: {
			mean: round(extra.reduce((a, b) => a + b, 0) / Math.max(1, extra.length)),
			p95: stat(extra).p95,
			max: stat(extra).max,
		},
		settled,
		committed,
		active,
		modes,
	};
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(result: RunResult): void {
	console.log(`\n${result.name}`);
	console.log(
		`  frames=${result.frames} keystrokes=${result.keystrokes} lost=${result.lost} coalesced=${result.coalesced}` +
			` live(settled/committed/active)=${result.settled}/${result.committed}/${result.active}` +
			` modes=${JSON.stringify(result.modes)}`,
	);
	console.log(
		`  painted blocks/frame   p50=${result.painted.p50} p95=${result.painted.p95} max=${result.painted.max}` +
			`  mean=${result.painted.mean}`,
	);
	console.log(
		`  container render calls p50=${result.calls.p50} p95=${result.calls.p95} p99=${result.calls.p99}` +
			` max=${result.calls.max} mean=${result.calls.mean}`,
	);
	console.log(
		`  calls per painted blk  p50=${result.callsPerPaintedBlock.p50} p95=${result.callsPerPaintedBlock.p95}` +
			` p99=${result.callsPerPaintedBlock.p99} max=${result.callsPerPaintedBlock.max} mean=${result.callsPerPaintedBlock.mean}`,
	);
	console.log(
		`  second renders/frame   mean=${result.extraRenders.mean} p95=${result.extraRenders.p95} max=${result.extraRenders.max}`,
	);
	console.log(
		`  transcript block ms    p50=${result.blockMs.p50} p95=${result.blockMs.p95} p99=${result.blockMs.p99}` +
			` max=${result.blockMs.max} mean=${result.blockMs.mean}`,
	);
	console.log(
		`  whole frame ms         p50=${result.frameCost.p50} p95=${result.frameCost.p95} p99=${result.frameCost.p99}` +
			` max=${result.frameCost.max} mean=${result.frameCost.mean}`,
	);
	console.log(
		`  frame ms not in blocks  p50=${result.residualMs.p50} p95=${result.residualMs.p95} p99=${result.residualMs.p99}` +
			` mean=${result.residualMs.mean}`,
	);
	console.log(
		`  keystroke-to-frame ms  p50=${result.latency.p50} p95=${result.latency.p95} p99=${result.latency.p99}` +
			` max=${result.latency.max} | handler ms p99=${result.inputHandle.p99}` +
			` | scheduler+cadence ms p50=${result.scheduleDelay.p50} p99=${result.scheduleDelay.p99}`,
	);
	const classes = Object.entries(result.byClass).sort((a, b) => b[1].callsPerFrame - a[1].callsPerFrame);
	for (const [kind, entry] of classes) {
		console.log(
			`    ${kind.padEnd(18)} calls/frame=${String(entry.callsPerFrame).padStart(7)}  ms/frame=${entry.msPerFrame}`,
		);
	}
}

async function main(): Promise<void> {
	for (const key of ["TMUX", "STY", "ZELLIJ", "TERM", "TMUX_PANE"]) delete Bun.env[key];
	await initTheme();

	const results: RunResult[] = [];

	// Warm the JIT on the real frame path, or the first scenario reports module
	// loading as a frame cost.
	await run("warmup", { liveTools: 2, toolHeight: 9, retiredTurns: 2, streamLines: 20, seed: 99 }, 60, 16);

	results.push(
		await run(
			"B — 1 live tool card, no streaming",
			{ liveTools: 1, toolHeight: 9, retiredTurns: 3, streamLines: 0, seed: 3 },
			300,
			16,
		),
	);
	results.push(
		await run(
			"C — 4 live tool cards, no streaming",
			{ liveTools: 4, toolHeight: 9, retiredTurns: 12, streamLines: 0, seed: 1 },
			300,
			16,
		),
	);
	results.push(
		await run(
			"F — 4 live tool cards + streaming tail",
			{ liveTools: 4, toolHeight: 9, retiredTurns: 12, streamLines: 120, seed: 6 },
			300,
			16,
		),
	);
	results.push(
		await run(
			"G — 12 live tool cards, tall cards, streaming tail",
			{ liveTools: 12, toolHeight: 24, retiredTurns: 12, streamLines: 120, seed: 7 },
			300,
			16,
		),
	);

	for (const result of results) report(result);

	const jsonIndex = Bun.argv.indexOf("--json");
	const jsonPath = jsonIndex === -1 ? undefined : Bun.argv[jsonIndex + 1];
	if (jsonPath !== undefined) {
		await Bun.write(jsonPath, `${JSON.stringify({ schema: "tui-transcript-render-count/1", results }, null, 2)}\n`);
		console.log(`\nJSON written to ${jsonPath}`);
	}
}

await main();
