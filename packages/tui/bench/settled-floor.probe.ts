/**
 * Why the product spec §4.5 validity gate can never be met on this harness.
 *
 * Structural probe. It measures NO latency and produces NO band. Its only job is
 * to answer, with a number rather than an argument, how many settled blocks the
 * benchmark fixture can hold — because `validityGate()` withholds every row's
 * verdict unless the live region holds {@link SETTLED_BLOCK_FLOOR} settled blocks,
 * and on this harness it holds 4.
 *
 * Two independent ceilings apply, and both must be lifted. Either one alone leaves
 * the gate unreachable:
 *
 * 1. **Block count.** `buildFixture()` creates `turns * 2 + 1` blocks. At the
 *    shipped `turns: 40` that is 81 blocks total, so there are not 200 blocks to
 *    settle. Raising the viewport cannot create blocks that do not exist.
 * 2. **Viewport rows.** Blocks must *fit* to stay settled. Each turn contributes a
 *    2-row user block and a 20-row assistant block, so 100 turns need 2 200 rows
 *    of viewport before all 200 can be settled at once.
 *
 * The shipped shape (`turns: 40`, `ROWS: 40`) is short by 119 blocks.
 *
 * The shape that clears the gate is not hypothetical: `probeAmplifier()` already
 * builds 256 one-row blocks in a 300-row viewport for spec §8.2, and this probe
 * measures that same shape reaching 231 settled blocks. So the gate is reachable
 * on this codebase — just not on the fixture the latency rows run on.
 *
 * Run: `bun packages/tui/bench/settled-floor.probe.ts`
 *
 * Changing the measured rows to that shape is a spec decision (see the §4.5
 * discussion in `validityGate()`), not one this probe makes.
 */
import { TranscriptContainer, type TranscriptStableRow } from "../src/chrome/transcript-container";
import { Text } from "../src/components/text";
import { COMPOSER_DEFAULTS, Composer } from "../src/prompt/composer";
import type { Component } from "../src/tui";
import { VirtualTerminal } from "../test/virtual-terminal";

/** Mirrors `COLUMNS`/`ROWS` in `keystroke-latency.bench.ts`. */
const COLUMNS = 120;
const ROWS = 40;
/** Mirrors `SETTLED_BLOCK_FLOOR` — the product spec §4.5 precondition. */
const FLOOR = 200;
/** Mirrors `MAX_LIVE_BLOCKS` in `transcript-container.ts:102`. */
const MAX_LIVE_BLOCKS = 256;
const SCROLLBACK = 200_000;

/** Rows each block of a turn occupies, as built by the latency fixture. */
const USER_ROWS = 2;
const ASSISTANT_ROWS = 20;

/** `ProbedBlock` from `keystroke-latency.bench.ts`, verbatim: the append-only
 * protocol needs `render` and `renderTranscriptStableRows`, and reimplementing it
 * is how a probe silently measures a different thing than the harness. */
class ProbedBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	readonly #text: Text;
	readonly #finalized: boolean;
	readonly #stable: readonly TranscriptStableRow[];
	#lastWidth = -1;
	#lastRows: readonly string[] | undefined;

	constructor(text: Text, rows: number, finalized: boolean) {
		this.#text = text;
		this.#finalized = finalized;
		this.#stable = Array.from({ length: rows }, (_, i) => ({ key: String(i) }));
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

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (this.#lastWidth !== width || this.#lastRows === undefined) this.render(width);
		return (this.#lastRows ?? []).slice(0, count);
	}

	render(width: number): readonly string[] {
		const rows = this.#text.render(width);
		this.#lastWidth = width;
		this.#lastRows = rows;
		return rows;
	}
}

function prose(n: number): string {
	return "word ".repeat(Math.ceil(n / 5)).slice(0, n);
}

/**
 * Build the latency fixture's block ledger at a given shape and settle it.
 *
 * `oneRow` reproduces `probeAmplifier()`'s §8.2 shape rather than the latency
 * fixture's: short one-row blocks, whose *text* fits the row they claim. Passing
 * long prose with a one-row ledger renders many rows per block and fills the
 * viewport anyway, which measures a different shape under the same name.
 */
async function settleAt(
	turns: number,
	rows: number,
	shape: "latency" | "oneRow",
): Promise<{ total: number; settled: number; heapMiB: number }> {
	const terminal = new VirtualTerminal(COLUMNS, rows, SCROLLBACK);
	const composer = new Composer({
		terminal,
		tuiOptions: { onPaint: () => {} },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		exit: () => {},
	});
	const transcript = new TranscriptContainer();
	for (let turn = 0; turn < turns; turn++) {
		if (shape === "oneRow") {
			for (let i = 0; i < 2; i++) {
				transcript.addChild(new ProbedBlock(new Text(`block ${turn * 2 + i}`, 0, 0), 1, true) as never);
			}
			continue;
		}
		transcript.addChild(new ProbedBlock(new Text(prose(300), 0, 0), USER_ROWS, true) as never);
		transcript.addChild(new ProbedBlock(new Text(prose(1200), 0, 0), ASSISTANT_ROWS, true) as never);
	}
	composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
	composer.ui.setFocus(composer.editor);
	composer.start({});
	await terminal.waitForRender();
	await Bun.sleep(800);
	await terminal.flush();
	const states = transcript.blockStates();
	const settled = states.filter(state => state === "settled").length;
	Bun.gc(true);
	const heapMiB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
	composer.ui.stop();
	return { total: states.length, settled, heapMiB };
}

console.log(`spec §4.5 settled-block floor : ${FLOOR}`);
console.log(`MAX_LIVE_BLOCKS (container)   : ${MAX_LIVE_BLOCKS}`);
console.log(`shipped fixture               : turns=40, ROWS=${ROWS}\n`);

console.log("ceiling 1 — block count. turns * 2 + 1 blocks exist; they cannot be settled if they do not exist:");
console.log("  turns | blocks | shortfall vs floor");
for (const turns of [40, 100, 200]) {
	const blocks = turns * 2 + 1;
	console.log(`  ${String(turns).padStart(5)} | ${String(blocks).padStart(6)} | ${blocks >= FLOOR ? "none" : `-${FLOOR - blocks}`}`);
}

console.log("\nceiling 2 — viewport rows. Blocks must fit to stay settled. Measured, not derived:");
console.log("  turns |  ROWS | blocks | settled | heap MiB | clears floor?");
for (const [turns, rows] of [
	[40, ROWS],
	[100, 2200],
] as const) {
	const r = await settleAt(turns, rows, "latency");
	console.log(
		`  ${String(turns).padStart(5)} | ${String(rows).padStart(5)} | ${String(r.total).padStart(6)} | ` +
			`${String(r.settled).padStart(7)} | ${String(r.heapMiB).padStart(8)} | ${r.settled >= FLOOR ? "YES" : "no"}`,
	);
}

console.log(`\nthe shape probeAmplifier() already builds for spec §8.2 — ${MAX_LIVE_BLOCKS} one-row blocks:`);
console.log(" blocks |  ROWS | settled | clears floor?");
for (const blocks of [128, 200, MAX_LIVE_BLOCKS]) {
	const r = await settleAt(blocks / 2, 300, "oneRow");
	console.log(
		` ${String(blocks).padStart(6)} | ${String(300).padStart(5)} | ${String(r.settled).padStart(7)} | ` +
			`${r.settled >= FLOOR ? "YES" : "no"}`,
	);
}

console.log(
	`\nreading: the §${FLOOR}-block precondition is unreachable on turns=40/ROWS=${ROWS} by construction,` +
		"\n         not by measurement noise. Raising ROWS alone does not help — the fixture has too few blocks.",
);
