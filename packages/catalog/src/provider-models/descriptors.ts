/**
 * Runtime model-manager factories for catalog providers. Everything else a
 * provider entry carries — default model, env keys, discovery wiring, seed
 * rows — is authored in `src/compat/rules/providers/<id>.kdl` and read from
 * the compiled entry (`src/compat/providers.ts`); this table holds only the
 * code half. Providers without a factory (`amazon-bedrock`, `azure`,
 * `gitlab-duo`, MiniMax, and the bespoke OAuth-driven managers
 * `google-antigravity` / `google-gemini-cli` / `openai-codex` built by the
 * coding-agent runtime) still have a KDL entry but no runtime discovery here.
 */
import type { KnownProvider } from "../compat/provider-ids";
import { providerEntries, providerEntry } from "../compat/providers";
import type { UnauthenticatedModelPolicy } from "../compat/types";
import type { Api, ModelCost, TokenCost } from "../types";
import type { ModelManagerOptions } from "../model-manager";
import type { ModelManagerConfig, ProviderDescriptor } from "./descriptor-types";
import { googleModelManagerOptions, googleVertexModelManagerOptions } from "./google";
import { ollamaCloudModelManagerOptions } from "./ollama";
import {
	abliterationModelManagerOptions,
	aiandModelManagerOptions,
	aimlApiModelManagerOptions,
	alibabaCodingPlanModelManagerOptions,
	alibabaTokenPlanModelManagerOptions,
	anthropicModelManagerOptions,
	basetenModelManagerOptions,
	bedrockMantleModelManagerOptions,
	cerebrasModelManagerOptions,
	charmHyperModelManagerOptions,
	clinePassModelManagerOptions,
	cloudflareAiGatewayModelManagerOptions,
	commandCodeModelManagerOptions,
	coreWeaveModelManagerOptions,
	deepinfraModelManagerOptions,
	deepseekModelManagerOptions,
	firepassModelManagerOptions,
	fireworksModelManagerOptions,
	githubCopilotModelManagerOptions,
	gmiCloudModelManagerOptions,
	groqModelManagerOptions,
	huggingfaceModelManagerOptions,
	kiloModelManagerOptions,
	kimiCodeModelManagerOptions,
	litellmModelManagerOptions,
	lmStudioModelManagerOptions,
	metaModelManagerOptions,
	museCodeModelManagerOptions,
	mistralModelManagerOptions,
	moonshotModelManagerOptions,
	nanoGptModelManagerOptions,
	novitaModelManagerOptions,
	nvidiaModelManagerOptions,
	ollamaModelManagerOptions,
	openaiModelManagerOptions,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	openrouterModelManagerOptions,
	qianfanModelManagerOptions,
	qwenPortalModelManagerOptions,
	sakanaModelManagerOptions,
	siliconflowCnModelManagerOptions,
	siliconflowModelManagerOptions,
	singularityApiDevModelManagerOptions,
	singularityApiTechModelManagerOptions,
	stepfunModelManagerOptions,
	syntheticModelManagerOptions,
	togetherModelManagerOptions,
	umansModelManagerOptions,
	veniceModelManagerOptions,
	vercelAiGatewayModelManagerOptions,
	vllmModelManagerOptions,
	waferServerlessModelManagerOptions,
	xaiModelManagerOptions,
	xaiOAuthModelManagerOptions,
	xiaomiModelManagerOptions,
	yoloAutoModelManagerOptions,
	zenmuxModelManagerOptions,
	zhipuCodingPlanModelManagerOptions,
} from "./openai-compat";
import {
	cursorModelManagerOptions,
	devinModelManagerOptions,
	gitLabDuoWorkflowModelManagerOptions,
	localModelManagerOptions,
	typesafeModelManagerOptions,
	webModelManagerOptions,
	zaiModelManagerOptions,
} from "./special";

export type { KnownProvider } from "../compat/provider-ids";

type ModelManagerFactory = (config: ModelManagerConfig) => ModelManagerOptions<Api>;

const MODEL_MANAGER_FACTORIES: Readonly<Partial<Record<KnownProvider, ModelManagerFactory>>> = {
	abliteration: config => abliterationModelManagerOptions(config),
	aiand: config => aiandModelManagerOptions(config),
	aimlapi: config => aimlApiModelManagerOptions(config),
	"alibaba-coding-plan": config => alibabaCodingPlanModelManagerOptions(config),
	"alibaba-token-plan": config => alibabaTokenPlanModelManagerOptions(config),
	baseten: config => basetenModelManagerOptions(config),
	"bedrock-mantle": config => bedrockMantleModelManagerOptions(config),
	anthropic: config => anthropicModelManagerOptions(config),
	cerebras: config => cerebrasModelManagerOptions(config),
	"charm-hyper": config => charmHyperModelManagerOptions(config),
	"cloudflare-ai-gateway": config => cloudflareAiGatewayModelManagerOptions(config),
	commandcode: config => commandCodeModelManagerOptions(config),
	cursor: config => cursorModelManagerOptions(config),
	deepinfra: config => deepinfraModelManagerOptions(config),
	deepseek: config => deepseekModelManagerOptions(config),
	devin: config => devinModelManagerOptions(config),
	"cline-pass": config => clinePassModelManagerOptions(config),
	firepass: config => firepassModelManagerOptions(config),
	fireworks: config => fireworksModelManagerOptions(config),
	"github-copilot": config => githubCopilotModelManagerOptions(config),
	"gitlab-duo-agent": config => gitLabDuoWorkflowModelManagerOptions(config),
	"gmi-cloud": config => gmiCloudModelManagerOptions(config),
	google: config => googleModelManagerOptions(config),
	"google-vertex": config => googleVertexModelManagerOptions(config),
	groq: config => groqModelManagerOptions(config),
	huggingface: config => huggingfaceModelManagerOptions(config),
	kilo: config => kiloModelManagerOptions(config),
	"kimi-code": config => kimiCodeModelManagerOptions(config),
	litellm: config => litellmModelManagerOptions(config),
	local: () => localModelManagerOptions(),
	"lm-studio": config => lmStudioModelManagerOptions(config),
	mistral: config => mistralModelManagerOptions(config),
	"muse-code": config => museCodeModelManagerOptions(config),
	meta: config => metaModelManagerOptions(config),
	moonshot: config => moonshotModelManagerOptions(config),
	nanogpt: config => nanoGptModelManagerOptions(config),
	nvidia: config => nvidiaModelManagerOptions(config),
	novita: config => novitaModelManagerOptions(config),
	ollama: config => ollamaModelManagerOptions(config),
	"ollama-cloud": config => ollamaCloudModelManagerOptions(config),
	openai: config => openaiModelManagerOptions(config),
	"opencode-go": config => opencodeGoModelManagerOptions(config),
	"opencode-zen": config => opencodeZenModelManagerOptions(config),
	openrouter: config => openrouterModelManagerOptions(config),
	qianfan: config => qianfanModelManagerOptions(config),
	"qwen-portal": config => qwenPortalModelManagerOptions(config),
	sakana: config => sakanaModelManagerOptions(config),
	siliconflow: config => siliconflowModelManagerOptions(config),
	"siliconflow-cn": config => siliconflowCnModelManagerOptions(config),
	"singularityapi-dev": config => singularityApiDevModelManagerOptions(config),
	"singularityapi-tech": config => singularityApiTechModelManagerOptions(config),
	stepfun: config => stepfunModelManagerOptions(config),
	synthetic: config => syntheticModelManagerOptions(config),
	together: config => togetherModelManagerOptions(config),
	typesafe: config => typesafeModelManagerOptions(config),
	umans: config => umansModelManagerOptions(config),
	venice: config => veniceModelManagerOptions(config),
	"vercel-ai-gateway": config => vercelAiGatewayModelManagerOptions(config),
	vllm: config => vllmModelManagerOptions(config),
	"wafer-serverless": config => waferServerlessModelManagerOptions(config),
	web: () => webModelManagerOptions(),
	coreweave: config => coreWeaveModelManagerOptions(config),
	xai: config => xaiModelManagerOptions(config),
	"xai-oauth": config => xaiOAuthModelManagerOptions(config),
	xiaomi: config => xiaomiModelManagerOptions(config),
	"xiaomi-token-plan-ams": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" }),
	"xiaomi-token-plan-cn": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-cn", tokenPlanRegion: "cn" }),
	"xiaomi-token-plan-sgp": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-sgp", tokenPlanRegion: "sgp" }),
	"yolo-auto": config => yoloAutoModelManagerOptions(config),
	zai: config => zaiModelManagerOptions(config),
	zenmux: config => zenmuxModelManagerOptions(config),
	"zhipu-coding-plan": config => zhipuCodingPlanModelManagerOptions(config),
};

function isKnownProvider(id: string): id is KnownProvider {
	return providerEntry(id) !== undefined;
}

/**
 * Runtime model-discovery descriptors: every catalog provider with a
 * model-manager factory, paired with its compiled KDL entry.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = Object.values(providerEntries()).flatMap(entry => {
	const createModelManagerOptions = isKnownProvider(entry.id) ? MODEL_MANAGER_FACTORIES[entry.id] : undefined;
	if (!createModelManagerOptions) return [];
	const discovery = entry.discovery;
	return [
		{
			providerId: entry.id,
			defaultModel: entry.defaultModel,
			createModelManagerOptions,
			allowUnauthenticated: entry.allowUnauthenticated,
			unauthenticatedModels: entry.unauthenticatedModels,
			dynamicModelsAuthoritative: entry.dynamicModelsAuthoritative,
			skipCrossProviderReferenceFills: entry.skipCrossProviderReferenceFills,
			catalogDiscovery: discovery ? { ...discovery, envVars: discovery.envVars ?? entry.envVars ?? [] } : undefined,
		},
	];
});

/**
 * Providers whose unauthenticated model roster is narrower than their
 * authenticated one, keyed by provider id. A host that meters paid SKUs but
 * serves zero-rated ones bare still 401s the rest, so the runtime keeps them
 * out of the picker for a caller with no credential.
 */
export const UNAUTHENTICATED_MODEL_POLICIES_BY_PROVIDER: ReadonlyMap<string, UnauthenticatedModelPolicy> = new Map(
	PROVIDER_DESCRIPTORS.flatMap(descriptor =>
		descriptor.unauthenticatedModels === undefined
			? []
			: [[descriptor.providerId, descriptor.unauthenticatedModels] as const],
	),
);

/** Default model IDs for all known providers, from their KDL entries. */
export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<KnownProvider, string>> = Object.fromEntries(
	Object.values(providerEntries()).map(entry => [entry.id, entry.defaultModel] as const),
) as Record<KnownProvider, string>;

function isZeroRateCard(card: TokenCost): boolean {
	return card.input === 0 && card.output === 0 && card.cacheRead === 0 && card.cacheWrite === 0;
}

/**
 * Whether a rate card bills nothing on any tier. A zero base card alone is not
 * enough: a long-context card or a dated effective-rate card could still meter
 * the request, and a host that meters it would reject the unauthenticated call.
 */
function isFreeCost(cost: ModelCost): boolean {
	if (!isZeroRateCard(cost)) return false;
	if (cost.longContext && !isZeroRateCard(cost.longContext)) return false;
	return (cost.timeBased?.effectiveRates ?? []).every(
		rate => isZeroRateCard(rate) && (!rate.longContext || isZeroRateCard(rate.longContext)),
	);
}

/**
 * Whether a model may be offered to a caller holding no credential for its
 * provider, per the provider's KDL `unauthenticated-models` policy. Callers
 * with a configured key are unaffected — the policy only narrows the
 * credential-free roster.
 */
export function isModelOfferedUnauthenticated(policy: UnauthenticatedModelPolicy, cost: ModelCost): boolean {
	return policy === "zero-cost" ? isFreeCost(cost) : true;
}
