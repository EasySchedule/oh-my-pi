/**
 * OpenCode Zen's credential-free tier.
 *
 * The Zen gateway meters its paid SKUs but serves its zero-rated ones to an
 * unauthenticated caller, so the free roster must be usable with no console
 * key while the metered models must not be advertised (they 401 with "Missing
 * API key"). These tests pin the KDL deployment contract and the roster
 * predicate that implements it; they read the rule, never `rules.json`, so an
 * upstream metadata shift cannot mask a rule regression.
 */
import { describe, expect, test } from "bun:test";
import type { EffectiveTokenCost, LongContextTokenCost, ModelCost } from "@oh-my-pi/pi-catalog/types";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	isModelOfferedUnauthenticated,
	PROVIDER_DESCRIPTORS,
	UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER,
} from "@oh-my-pi/pi-catalog/provider-models";

const ZEN = "opencode-zen";

const FREE_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PAID_COST: ModelCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

/** A long-context card that still charges nothing. */
const freeLongContext: LongContextTokenCost = { ...FREE_COST, inputThreshold: 200_000 };
/** A dated replacement card that still charges nothing. */
const freeRate = (effectiveFrom: number): EffectiveTokenCost => ({
	...FREE_COST,
	effectiveFrom,
	longContext: freeLongContext,
});

describe("OpenCode Zen credential-free tier", () => {
	test("the provider rule admits Zen without a key and pins the zero-cost policy", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === ZEN);
		expect(descriptor).toMatchObject({
			allowUnauthenticated: true,
			unauthenticatedModels: "zero-cost",
		});
		expect(UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER.get(ZEN)).toBe("zero-cost");
	});

	test("Zen's default model is a zero-rated model, so a keyless default pick can run", () => {
		// The default is what a fresh install with no credentials anywhere boots
		// on. It must satisfy the `zero-cost` policy, or the startup pick would
		// resolve to a metered model that 401s on its first request.
		expect(DEFAULT_MODEL_PER_PROVIDER[ZEN]).toBe("space-bunny-free");
		const [defaultModel] = getBundledModels(ZEN).filter(model => model.id === DEFAULT_MODEL_PER_PROVIDER[ZEN]);
		expect(defaultModel).toBeDefined();
		expect(isModelOfferedUnauthenticated("zero-cost", defaultModel!.cost)).toBe(true);
	});

	test("every zero-rated Zen model satisfies the unauthenticated policy", () => {
		// The whole point of the tier: if any model a keyless caller is offered
		// were metered, the pick would resurface as a 401 the user cannot
		// diagnose. Read the rule's roster, not the compiled rules.json.
		const models = getBundledModels(ZEN);
		const free = models.filter(model => isModelOfferedUnauthenticated("zero-cost", model.cost));
		expect(free.length).toBeGreaterThan(0);
		expect(free.map(model => model.id)).toContain("space-bunny-free");
		// Metered models are still bundled, so a keyed caller loses nothing.
		expect(free.length).toBeLessThan(models.length);
	});

	test("only opencode-zen declares a narrowed unauthenticated roster", () => {
		// Every other provider that tolerates a missing key (openrouter, kilo,
		// novita, ollama, …) meters everything, so nothing else may be filtered
		// out of the picker for a credential-free caller.
		expect([...UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER.keys()]).toEqual([ZEN]);
	});

	test("a zero base rate alone does not make a model free when another tier meters it", () => {
		// A long-context or dated effective-rate card that charges turns a
		// nominally zero base card into a metered model the host would reject.
		expect(
			isModelOfferedUnauthenticated("zero-cost", { ...FREE_COST, longContext: { ...freeLongContext, input: 1 } }),
		).toBe(false);
		expect(
			isModelOfferedUnauthenticated("zero-cost", {
				...FREE_COST,
				timeBased: {
					offPeakMultiplier: 1,
					peakWindows: [],
					effectiveRates: [{ ...FREE_COST, effectiveFrom: 0, output: 2 }],
				},
			}),
		).toBe(false);
		// A metered long-context card nested inside a dated card counts too.
		expect(
			isModelOfferedUnauthenticated("zero-cost", {
				...FREE_COST,
				timeBased: {
					offPeakMultiplier: 1,
					peakWindows: [],
					effectiveRates: [{ ...FREE_COST, effectiveFrom: 0, longContext: { ...freeLongContext, output: 2 } }],
				},
			}),
		).toBe(false);
	});

	test("every rate on every tier zero is free; any single metered rate is not", () => {
		expect(
			isModelOfferedUnauthenticated("zero-cost", {
				...FREE_COST,
				longContext: freeLongContext,
				timeBased: { offPeakMultiplier: 1, peakWindows: [], effectiveRates: [freeRate(0), freeRate(1)] },
			}),
		).toBe(true);
		// cacheWrite is the rate a subscriber-funded gateway meters least
		// visibly, so pin that it alone disqualifies a model.
		expect(isModelOfferedUnauthenticated("zero-cost", { ...FREE_COST, cacheWrite: 1 })).toBe(false);
		expect(isModelOfferedUnauthenticated("zero-cost", PAID_COST)).toBe(false);
	});
});
