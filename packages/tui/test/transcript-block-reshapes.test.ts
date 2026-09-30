import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { CollabQrCodeComponent } from "@oh-my-pi/pi-tui/chrome/collab-qrcode";
import { MessageDividerComponent } from "@oh-my-pi/pi-tui/chrome/message-divider";
import { TranscriptContainer, type TranscriptPresentationTarget } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const frame = { tick: 0, now: 0 };
const SRC = path.join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
	});
}

const CLASS_DECL = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z0-9_$]+)/g;

interface ClassSpan {
	readonly name: string;
	readonly start: number;
	/** Offset just past this class, where the next one begins. */
	readonly end: number;
}

/**
 * Class spans in source order. A method belongs to the last class declared
 * before it, and a class field belongs to the span it was written in — so
 * "this class declares it" is decided by the class's own text, never by a
 * sibling's and never by the interface default.
 */
function classSpans(source: string): ClassSpan[] {
	const spans: { name: string; start: number; end: number }[] = [];
	CLASS_DECL.lastIndex = 0;
	for (let match = CLASS_DECL.exec(source); match !== null; match = CLASS_DECL.exec(source)) {
		spans.push({ name: match[1]!, start: match.index, end: source.length });
	}
	for (let i = 0; i < spans.length; i++) spans[i]!.end = spans[i + 1]?.start ?? source.length;
	return spans;
}

/** The class a `setTranscriptAllocation` definition at `index` sits in. */
function owningClass(spans: readonly ClassSpan[], index: number): ClassSpan | undefined {
	let owner: ClassSpan | undefined;
	for (const span of spans) {
		if (span.start > index) break;
		owner = span;
	}
	return owner;
}

/** Every class in the TUI that a reservation can reach. */
function reservingClasses(): { className: string; file: string; declaresFlag: boolean }[] {
	const found: { className: string; file: string; declaresFlag: boolean }[] = [];
	for (const file of sourceFiles(SRC)) {
		const source = fs.readFileSync(file, "utf8");
		const spans = classSpans(source);
		const method = /^[ \t]*setTranscriptAllocation\s*\(/gm;
		for (let match = method.exec(source); match !== null; match = method.exec(source)) {
			const owner = owningClass(spans, match.index);
			if (owner === undefined) continue;
			// The declaration must sit in this class's own body. Reading past
			// `end` would let a later sibling's declaration vouch for this one.
			const declaresFlag = /^[ \t]*(?:override[ \t]+)?readonly reshapesWhenSqueezed\s*(?::[^=]+)?=/m.test(
				source.slice(owner.start, owner.end),
			);
			found.push({ className: owner.name, file: path.relative(SRC, file), declaresFlag });
		}
	}
	return found;
}

/** Counts the container's own calls to `render`, on the real class, unpolluted. */
function spyRenders(component: Component): () => number {
	const target = component as { render: (width: number) => readonly string[] };
	const original = target.render.bind(target);
	let renders = 0;
	target.render = (width: number) => {
		renders++;
		return original(width);
	};
	return () => renders;
}

/** A tool card with a tall, stable result, built with no renderer and no terminal. */
function tallToolBlock(): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		{ command: "true" },
		{ useBuiltInRenderer: false },
		undefined,
		{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		process.cwd(),
	);
	component.setTranscriptAllocation(Number.MAX_SAFE_INTEGER, frame);
	component.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }] }, false);
	return component;
}

describe("transcript block reshapesWhenSqueezed declarations", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	describe("the audited population", () => {
		it("declares the flag on every class a reservation can reach", () => {
			const reserving = reservingClasses();
			expect(reserving.length).toBeGreaterThan(0);
			const undeclared = reserving.filter(entry => !entry.declaresFlag);
			expect(undeclared).toEqual([]);
		});

		it("keeps the reserving population pinned to the two blocks that reshape", () => {
			// Pinned so a third reserving block is a deliberate review event. It
			// cannot pass silently on the interface default of `true`, because the
			// test above already fails a class that declares nothing at all.
			expect(
				reservingClasses()
					.map(entry => entry.className)
					.sort(),
			).toEqual(["CollabQrCodeComponent", "ToolExecutionComponent"]);
		});

		it("leaves the interface default unreachable, so the polarity choice changes no block", () => {
			// This is the audit's answer to "should the default be `false`?". Because
			// every class a reservation can reach declares the flag itself, the
			// default is unreachable for all of them: flipping it to `false` would
			// repaint nothing and save nothing in production, and would only hand the
			// next block that forgets to declare a truncated full render. The
			// conservative default costs nothing measurable, so it stays.
			//
			// The consequence worth stating: there is no production block that can
			// honestly declare `false`, because a block that ignores its reservation
			// has no way for the allocator to hand it one. The flag is unreachable
			// for those blocks, not merely unfavourable.
			const reachable = reservingClasses();
			expect(reachable.every(entry => entry.declaresFlag)).toBe(true);
			expect(reachable.filter(entry => !entry.declaresFlag)).toHaveLength(0);
		});
	});

	describe("ToolExecutionComponent declares true", () => {
		it("renders the compact card, not a truncated full render, when squeezed", () => {
			const transcript = new TranscriptContainer();
			const block = tallToolBlock();
			// Read the un-squeezed render before the spy is installed, so the count
			// below is the container's work and not this test's own probe.
			const full = block.render(80);
			expect(full.length).toBeGreaterThan(3);
			const renders = spyRenders(block);
			transcript.addChild(block);
			transcript.beginFrame(frame);

			// One row of capacity against a block that measured more than one.
			const viewport = transcript.renderViewport(80, 1, frame);

			// The declaration is honest: the squeeze reaches the block and changes
			// its bytes, so the second render is the block's own presentation and
			// cannot be skipped. One render would paint a truncated full card.
			expect(renders()).toBe(2);
			expect(viewport).toHaveLength(1);
			expect(viewport).not.toEqual(full.slice(0, 1));
		});

		it("would paint a truncated card if it declared false, which is what keeps it true", () => {
			// The mirror, on the real class: overriding the declaration to `false`
			// must drop the render to one *and* change the painted bytes. Without
			// the byte assertion this would be a ratchet — a test that only counts
			// renders would be satisfied by a block lying about itself.
			const transcript = new TranscriptContainer();
			const block = tallToolBlock();
			const full = block.render(80);
			(block as { reshapesWhenSqueezed: boolean }).reshapesWhenSqueezed = false;
			const renders = spyRenders(block);
			transcript.addChild(block);
			transcript.beginFrame(frame);

			const viewport = transcript.renderViewport(80, 1, frame);

			expect(renders()).toBe(1);
			// The regression the declaration exists to prevent, named: the tail of
			// the full card stands in for the compact card the block asked for.
			expect(viewport).toEqual(full.slice(0, 1));
		});
	});

	describe("CollabQrCodeComponent declares true", () => {
		it("renders the hidden hint, not a truncated grid, when squeezed", () => {
			const transcript = new TranscriptContainer();
			const block = new CollabQrCodeComponent("https://my.omp.sh/#full-control");
			const full = block.render(120);
			expect(full.length).toBeGreaterThan(1);
			const renders = spyRenders(block);
			transcript.addChild(block);
			transcript.beginFrame(frame);

			// A QR grid measured over several rows, given one.
			const viewport = transcript.renderViewport(120, 1, frame);

			expect(renders()).toBe(2);
			expect(viewport).toHaveLength(1);
			expect(viewport[0]).toContain("QR code hidden");
			expect(viewport[0]).not.toEqual(full[0]);
		});

		it("would paint a truncated grid if it declared false, which is what keeps it true", () => {
			const transcript = new TranscriptContainer();
			const block = new CollabQrCodeComponent("https://my.omp.sh/#full-control");
			const full = block.render(120);
			(block as { reshapesWhenSqueezed: boolean }).reshapesWhenSqueezed = false;
			const renders = spyRenders(block);
			transcript.addChild(block);
			transcript.beginFrame(frame);

			const viewport = transcript.renderViewport(120, 1, frame);

			expect(renders()).toBe(1);
			// A half-scannable QR grid is worse than no code: the join URL is gone
			// and the pixels lie. That is the whole reason this block declares true.
			expect(viewport).toEqual(full.slice(0, 1));
			expect(viewport[0]).not.toContain("QR code hidden");
		});
	});

	describe("a block that takes no reservation", () => {
		it("renders a real production block once per frame when it is clipped", () => {
			const transcript = new TranscriptContainer();
			const divider = new MessageDividerComponent({ label: () => "turn", labelColor: "accent" });
			const renders = spyRenders(divider);
			transcript.addChild(divider);
			transcript.beginFrame(frame);

			transcript.renderViewport(80, 1, frame);

			// `MessageDividerComponent` implements no `setTranscriptAllocation`, so
			// no reservation can reach its render. One render is the whole frame's
			// work for it, clipped or not, and no declaration can change that — the
			// flag is unreachable for a block with no reservation channel. This is
			// the shape of most of the transcript: an assistant block, a user
			// block, a divider, a markdown message.
			expect((divider as Partial<TranscriptPresentationTarget>).reshapesWhenSqueezed).toBeUndefined();
			expect(renders()).toBe(1);
		});
	});
});
