/**
 * OpenCode Zen without a console key.
 *
 * The Zen gateway serves its zero-rated SKUs to an unauthenticated caller and
 * answers every metered SKU with 401 "Missing API key". Two contracts follow,
 * and both are what a user without an OpenCode account observes:
 *
 *   1. No credential — Zen is offered at all (previously the provider was
 *      invisible in `/model` and `omp models ls`), the free roster is listed,
 *      the metered roster is withheld rather than advertised-and-failing, and
 *      request auth resolves to the no-auth sentinel so the transport emits no
 *      `Authorization` header. The gateway rejects a bogus bearer
 *      ("Invalid API key") where a bare request succeeds, so the sentinel is
 *      the only credential that works here.
 *   2. With a key — the whole roster is offered again, and the stored key
 *      wins over the keyless sentinel.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER,
} from "@oh-my-pi/pi-catalog/provider-models";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const ZEN = "opencode-zen";
/** A metered Zen SKU: present in the bundle, served only to a keyed caller. */
const METERED_MODEL = "claude-opus-5";
/** A zero-rated Zen SKU: the roster an unauthenticated caller may use. */
const FREE_MODEL = "space-bunny-free";
const ZEN_KEY = "sk-zen-contract-test-key";

const savedEnv = new Map<string, string | undefined>();
let tempDir = "";

beforeAll(() => {
	savedEnv.set("OPENCODE_API_KEY", Bun.env.OPENCODE_API_KEY);
	delete Bun.env.OPENCODE_API_KEY;
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-zen-keyless-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = "";
});

/**
 * Boots a registry over the bundled catalog only. No `fetch` is supplied, so
 * discovery is the test-runtime stub and the bundled slice is what the picker
 * would show a user who has not refreshed.
 */
async function bootRegistry(
	name: string,
	modelsYml?: string,
): Promise<{ registry: ModelRegistry; storage: AuthStorage }> {
	const storage = await AuthStorage.create(path.join(tempDir, `${name}.db`));
	const modelsPath = path.join(tempDir, `${name}.yml`);
	// With no body the path does not exist, so the catalog-keyless path is the
	// only source of keylessness.
	if (modelsYml !== undefined) fs.writeFileSync(modelsPath, modelsYml, "utf8");
	const registry = new ModelRegistry(storage, modelsPath, {
		cacheDbPath: path.join(tempDir, `${name}-cache.db`),
	});
	return { registry, storage };
}

function zenAvailable(registry: ModelRegistry): Model<Api>[] {
	return registry.getAvailable().filter(model => model.provider === ZEN);
}

describe("OpenCode Zen credential-free tier", () => {
	test("with no credential Zen is offered, filtered to the zero-rated roster, and sends the no-auth sentinel", async () => {
		const { registry, storage } = await bootRegistry("keyless");

		const offered = zenAvailable(registry);
		const offeredIds = offered.map(model => model.id);

		// Contract: the free tier is reachable without an OpenCode account.
		expect(offeredIds).toContain(FREE_MODEL);
		// Contract: the metered roster is not advertised, because every one of
		// those requests would 401 with "Missing API key" the moment a user
		// picked it.
		expect(offeredIds).not.toContain(METERED_MODEL);
		// The bundle keeps the full roster: this is a presentation filter, not
		// a catalog truncation, so a keyed caller loses nothing.
		expect(registry.getAll().some(model => model.provider === ZEN && model.id === METERED_MODEL)).toBe(true);

		// Contract: request auth resolves to the sentinel, which the transports
		// turn into a bare request. A bogus bearer is rejected by the gateway.
		const free = registry.find(ZEN, FREE_MODEL);
		expect(free).toBeDefined();
		expect(await registry.getApiKey(free!)).toBe(kNoAuth);
		// Explicit selection (`--model`, /model) gates on these. A free tier is
		// reachable, so an explicit Zen selector must resolve.
		expect(registry.hasConfiguredAuth(free!)).toBe(true);
		// But it is not a *concrete* credential: the user never signed in, and
		// counting it would let Zen displace the provider they did sign into
		// when picking the startup default.
		expect(registry.hasConcreteAuth(ZEN)).toBe(false);

		// Every advertised model is actually free — a leaked metered SKU here
		// would resurface as a 401 the user cannot diagnose.
		for (const model of offered) {
			expect({ id: model.id, metered: model.cost.input > 0 || model.cost.output > 0 }).toEqual({
				id: model.id,
				metered: false,
			});
		}
		storage.close();
	});

	test("a configured key restores the full roster and wins over the keyless sentinel", async () => {
		const { registry, storage } = await bootRegistry("keyed");
		expect(zenAvailable(registry).map(model => model.id)).not.toContain(METERED_MODEL);

		await storage.oauth.login(ZEN, { onAuth: () => {}, onPrompt: async () => ZEN_KEY });

		const keyed = new ModelRegistry(storage, path.join(tempDir, "keyed-absent.yml"), {
			cacheDbPath: path.join(tempDir, "keyed-cache.db"),
		});
		const offeredIds = zenAvailable(keyed).map(model => model.id);
		expect(offeredIds).toContain(METERED_MODEL);
		expect(offeredIds).toContain(FREE_MODEL);

		const metered = keyed.find(ZEN, METERED_MODEL);
		expect(metered).toBeDefined();
		expect(await keyed.getApiKey(metered!)).toBe(ZEN_KEY);
		// A signed-in Zen is a concrete credential again, so it may win the
		// startup default against another signed-in provider.
		expect(keyed.hasConcreteAuth(ZEN)).toBe(true);
		storage.close();
	});
});

describe("OpenCode Zen as the credential-free default", () => {
	test("the provider default is a model the keyless roster actually offers", () => {
		// A default outside the credential-free roster would boot a fresh
		// install onto a metered model that 401s on its first request, which is
		// exactly the failure the `zero-cost` policy exists to prevent.
		expect(UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER.get(ZEN)).toBe("zero-cost");
		expect(DEFAULT_MODEL_PER_PROVIDER[ZEN]).toBe(FREE_MODEL);
	});

	test("with nothing credentialed anywhere, the startup default is the free Zen model", async () => {
		// The fresh-install path: no models.yml, no session, no modelRoles
		// default, no stored key. `pickDefaultAvailableModel` must land on a
		// model the user can actually run.
		const { registry, storage } = await bootRegistry("pick-keyless");
		const available = registry.getAvailable();
		const pick = pickDefaultAvailableModel(available, provider => registry.hasConcreteAuth(provider));

		expect(pick).toBeDefined();
		expect(`${pick!.provider}/${pick!.id}`).toBe(`${ZEN}/${FREE_MODEL}`);
		storage.close();
	});

	test("a signed-in provider keeps the default; the free tier never displaces it", async () => {
		// Regression guard for the precedence rule behind issue #9967: a
		// provider the user never authenticated with is always "available", so
		// if it counted as a concrete credential it would outrank whatever the
		// user actually signed into.
		const { registry: signedIn, storage } = await bootRegistry(
			"pick-anthropic",
			'providers:\n  anthropic:\n    apiKey: "sk-ant-test-key"\n',
		);
		expect(await storage.keys.peek("anthropic")).toBe("sk-ant-test-key");

		expect(signedIn.hasConcreteAuth(ZEN)).toBe(false);
		expect(signedIn.hasConcreteAuth("anthropic")).toBe(true);
		// The signed-in provider is now offered alongside the free tier.
		expect(signedIn.getAvailable().some(model => model.provider === "anthropic")).toBe(true);

		const pick = pickDefaultAvailableModel(signedIn.getAvailable(), provider => signedIn.hasConcreteAuth(provider));
		expect(pick?.provider).toBe("anthropic");
		storage.close();
	});
});
