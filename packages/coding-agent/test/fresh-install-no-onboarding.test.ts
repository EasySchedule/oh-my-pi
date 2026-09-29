/**
 * A fresh install must reach the prompt without the onboarding wizard.
 *
 * Failure mode this defends: a new user sits through a multi-step wizard —
 * splash, sign-in, model, glyph, theme — before they can type. The bundled
 * default model and the default theme mean there is nothing to onboard into,
 * so the wizard must not auto-run. It must still be reachable on demand
 * (`omp setup` / `/setup`), which is what `force` covers.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupSetupWizard, cfgThemeDark, cfgThemeLight } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { selectSetupScenes } from "@oh-my-pi/pi-tui/setup/wizard";
import { ALL_SCENES } from "@oh-my-pi/pi-tui/setup/wizard";

const sceneIds = (scenes: readonly { id: string }[]): string[] => scenes.map(scene => scene.id).sort();

/** The wizard host contract is opaque here; only scene selection is under test. */
const host = {} as Parameters<typeof selectSetupScenes>[2];

describe("fresh-install onboarding", () => {
	test("the setup wizard is off by default, so a fresh install selects no scenes", async () => {
		// The failure a user would feel: an empty config.yml answers the
		// cold-launch gate, and the wizard must contribute nothing. This mirrors
		// the cold-launch call site, which forwards the resolved setting.
		const settings = Settings.isolated();
		expect(cfgStartupSetupWizard.get(settings)).toBe(false);
		const scenes = await selectSetupScenes(0, ALL_SCENES, host, {
			isTTY: true,
			setupWizardEnabled: cfgStartupSetupWizard.get(settings),
		});
		expect(scenes).toEqual([]);
	});

	test("the default theme is already what onboarding would have written", async () => {
		// The wizard's "Match terminal" row saves exactly these two values, so
		// skipping onboarding must not change what a new user sees.
		expect(cfgThemeDark.get(Settings.isolated())).toBe("titanium");
		expect(cfgThemeLight.get(Settings.isolated())).toBe("light");
	});

	test("the wizard is still reachable on demand, and opting back in re-enables it", async () => {
		const settingsWithWizard = Settings.isolated();
		cfgStartupSetupWizard.set(settingsWithWizard, true);

		const ctx = {
			settings: settingsWithWizard,
			getModels: () => [],
			ui: { requestRender: () => {}, terminal: { rows: 24, columns: 80 } },
		} as unknown as NonNullable<Parameters<typeof selectSetupScenes>[2]>;

		// `omp setup` / `/setup` force past the setting and the version gate.
		const forced = await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, force: true });
		expect(forced.length).toBe(ALL_SCENES.length);

		// Opting back in re-enables the per-version scenes without a forced run.
		const opted = await selectSetupScenes(0, ALL_SCENES, ctx, {
			isTTY: true,
			setupWizardEnabled: cfgStartupSetupWizard.get(settingsWithWizard),
		});
		expect(opted.length).toBe(ALL_SCENES.length);
		expect(sceneIds(opted)).toEqual(sceneIds(ALL_SCENES));
	});
});
