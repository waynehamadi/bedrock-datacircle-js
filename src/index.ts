// Amazon Bedrock Converse tools on Datacircle's open API: find the best GTM APIs. The API needs no key:
// https://api.datacircle.dev/v1 (its spec: https://api.datacircle.dev/v1/openapi.json). More at https://datacircle.dev

import { ApiError, BASE_URL, Client, VERSION, brief, briefPlans, clamp, objects, slugify } from './client.js';
import type { Answer, DatacircleOptions } from './client.js';

export { ApiError, BASE_URL, VERSION };
export type { Answer, DatacircleOptions };

const LIST_APIS_ABOUT = "Lists the GTM APIs on Datacircle's sheet (https://datacircle.dev). GTM means go-to-market. GTM APIs are the APIs sales and marketing teams use. Gives each API's slug, how many plans and providers it has and its best plan. Call it first to find an API's slug.";
const BEST_PLANS_ABOUT = "Gives an API's plans best first by their score out of 100 on Datacircle's benchmark (https://datacircle.dev), each with its rank, provider, plan, $ per 1,000 calls and its page. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const SEARCH_PLANS_ABOUT = "Searches every plan on Datacircle's sheet (https://datacircle.dev), or one API's, by provider or plan name, sorted by score, provider or price. Gives how many were found and up to limit of them. perThousand is a plan's price of 1,000 items in dollars, pay the plan's whole price in its currency.";
const PROVIDER_ABOUT = "Gives each API one provider sells and its rank on each on Datacircle's benchmark (https://datacircle.dev), with its best plan there, its best rank first. total is how many APIs it sells, ranked on how many of them it has a rank. For an API's best providers, call datacircle_best_plans.";

// Tells a model that sent a provider's name to an API's tool where a provider's plans are.
const FOR_PROVIDER = "A provider's plans: datacircle_search_plans with its name as query, like bright data, or datacircle_provider.";

// Tells a model that sent an API's slug to the provider's tool where an API's best providers are.
const FOR_API = "An API's best providers: datacircle_best_plans with the API's slug, like email-finder.";

// Each input's schema, what the model is sent, and its check, what runToolUse runs on the model's input. The check is
// looser than the schema, so that a small model that strays is understood where it can be: null is a key left out, a
// key of its own is dropped, a number sent as text is read as one, a fraction cut to its whole part, a limit or an
// offset below 1 takes its default. What it refuses, the model reads why.
type Checked = { value: unknown } | { refused: string };
type Field = { json: DatacircleProperty; check: (value: unknown) => Checked; needed?: true };
const shown = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value));

const count = (low: number, high: number | null, description: string): Field => ({
  json: { type: 'integer', minimum: low, ...(high === null ? {} : { maximum: high }), description },
  check: (value) => {
    if (value === undefined || value === null) return { value: undefined };
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? { value: n } : { refused: `expected a number, got ${shown(value)}` };
  },
});
const text = (description: string): Field => ({
  json: { type: 'string', description },
  check: (value) => (value === undefined || value === null ? { value: undefined } : typeof value === 'string' ? { value } : { refused: `expected text, got ${shown(value)}` }),
});
const needed = (description: string): Field => ({
  json: { type: 'string', description },
  check: (value) => (typeof value === 'string' ? { value } : { refused: `expected text, got ${shown(value)}` }),
  needed: true,
});
const choice = (values: [string, ...string[]], description: string): Field => ({
  json: { type: 'string', enum: values, description },
  check: (value) => (value === undefined || value === null ? { value: undefined }
    : typeof value === 'string' && values.includes(value) ? { value } : { refused: `expected one of ${values.join(', ')}, got ${shown(value)}` }),
});

type Input = { json: DatacircleSchema; check: (input: unknown) => { data: Record<string, unknown> } | { refused: string[] } };
function input(fields: Record<string, Field>): Input {
  const keys = Object.keys(fields);
  const required = keys.filter((key) => fields[key].needed);
  return {
    // No required list when none is needed, and no additionalProperties: the JSON schema every Bedrock model takes.
    json: {
      type: 'object',
      properties: Object.fromEntries(keys.map((key) => [key, fields[key].json])),
      ...(required.length > 0 ? { required } : {}),
    },
    check: (given) => {
      if (typeof given !== 'object' || given === null || Array.isArray(given)) return { refused: [`expected an object, got ${shown(given)}`] };
      const data: Record<string, unknown> = {};
      const refused: string[] = [];
      for (const key of keys) {
        const checked = fields[key].check((given as Record<string, unknown>)[key]);
        if ('refused' in checked) refused.push(`${key}: ${checked.refused}`);
        else if (checked.value !== undefined) data[key] = checked.value;
      }
      return refused.length > 0 ? { refused } : { data };
    },
  };
}

const listApisInput = input({
  query: text("Words of the API's name or slug, like email or linkedin profile: the APIs that hold the most of them come first. Left out, the sheet's order"),
  limit: count(1, 200, 'How many APIs to give, 1 to 200. 20 when left out: the sheet has about 150'),
});

const bestPlansInput = input({
  slug: needed("The API's slug, like email-finder or linkedin-profile, as datacircle_list_apis gives it"),
  limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
});

const searchPlansInput = input({
  api: text("Only this API's plans: its name or slug, like email-finder. A provider's name goes in query, never here. Left out, every API"),
  query: text("Words that must all appear in the provider's or plan's name, like bright data. Left out, every plan"),
  sort: choice(['score', 'provider', 'price'], 'score (best first, the default), provider (A to Z) or price ($ per 1,000, lowest first)'),
  limit: count(1, 50, 'How many plans to give, 1 to 50. 10 when left out'),
  offset: count(0, null, 'How many found plans to skip first. 0 when left out'),
});

const providerInput = input({
  slug: needed("The provider's slug, like bright-data, or its name, like Bright Data: the name is made a slug"),
});

/** datacircle_list_apis' input. */
export type ListApisInput = { query?: string | null; limit?: number | null };
/** datacircle_best_plans' input. */
export type BestPlansInput = { slug: string; limit?: number | null };
/** datacircle_search_plans' input. */
export type SearchPlansInput = { api?: string | null; query?: string | null; sort?: 'score' | 'provider' | 'price' | null; limit?: number | null; offset?: number | null };
/** datacircle_provider's input. */
export type ProviderInput = { slug: string };

/** A limit the model sent, within the API's bounds, or undefined for the API's default. */
const bounded = (n: number | null | undefined, high: number) => (n === undefined || n === null || !(n >= 1) ? undefined : clamp(n, 1, high));

/** An answer of 4xx (an unknown slug, a wrong argument) is the call's answer as {error}, the API's words. */
function asResult(error: unknown): Answer {
  if (error instanceof ApiError) return { error: error.message };
  throw error;
}

async function listApisRun(client: Client, { query, limit }: ListApisInput, signal?: AbortSignal): Promise<Answer> {
  let apis: Answer[];
  try {
    apis = objects(await client.get<unknown>('/apis', {}, signal));
  } catch (error) {
    return asResult(error);
  }
  const words = (query ?? '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const found = apis
    .map((api, order) => {
      const name = `${String(api.api ?? '')} ${String(api.slug ?? '').replace(/-/g, ' ')}`.toLowerCase();
      return { order, matched: words.filter((word) => name.includes(word)).length, api };
    })
    .filter(({ matched }) => matched > 0 || words.length === 0)
    // The most words matched first, the sheet's order within each.
    .sort((a, b) => b.matched - a.matched || a.order - b.order);
  const answer: Answer = {
    total: found.length,
    apis: found.slice(0, bounded(limit, 200) ?? 20)
      .map(({ api }) => brief(api, ['api', 'slug', 'plans', 'providers', 'best', 'bestPage', 'sheetPage'])),
  };
  if (words.length > 0 && (found.length === 0 || found[0].matched < words.length)) {
    // A provider's name sent as an API's, like Bright Data, whose data matches many APIs: where its plans are.
    answer.note = `No API's name holds every word of ${JSON.stringify(query)}. A provider's plans: datacircle_search_plans with its name as query, or datacircle_provider.`;
  }
  return answer;
}

/** A placeholder a small model copies from a prompt's example, like <api-slug>, sent in place of a slug. */
const PLACEHOLDER = /[<>{}]/;

async function bestPlansRun(client: Client, { slug, limit }: BestPlansInput, signal?: AbortSignal): Promise<Answer> {
  if (PLACEHOLDER.test(slug ?? '')) {
    return { error: `${JSON.stringify(slug)} is a placeholder. Give the API's own slug, like email-finder: datacircle_list_apis gives every slug.` };
  }
  const api = slugify(slug ?? '');
  if (api === '') return { error: `Give an API's slug, like email-finder: datacircle_list_apis gives every slug. ${FOR_PROVIDER}` };
  const best = async (api: string) => {
    const answer = await client.get(`/apis/${api}/best`, { limit: bounded(limit, 50) }, signal);
    return { ...answer, plans: briefPlans(answer.plans) };
  };
  try {
    return await best(api);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // The slug with "api" after it, like serp-api, as the sheet's address reads (/serp-api-pricing): the API's own.
      const bare = api.replace(/-api(-pricing)?$/, '');
      if (bare !== api && bare !== '') {
        try {
          return { ...(await best(bare)), note: `No API has the slug ${api}: these are ${bare}'s plans.` };
        } catch {
          // The first answer stands.
        }
      }
      // A provider's name sent as the API's slug: the API's words, and where a provider's plans are.
      return { error: `${error.message}. datacircle_list_apis gives every API's slug. ${FOR_PROVIDER}` };
    }
    return asResult(error);
  }
}

async function searchPlansRun(client: Client, input: SearchPlansInput, signal?: AbortSignal): Promise<Answer> {
  const search = (api: string, query: string) =>
    client.get('/plans', {
      api: api.trim(),
      query: query.trim(),
      sort: input.sort ?? undefined,
      limit: bounded(input.limit, 50),
      offset: input.offset === undefined || input.offset === null || !(input.offset > 0) ? undefined : Math.trunc(input.offset),
    }, signal);
  let api = input.api ?? '';
  let query = input.query ?? '';
  const notes: string[] = [];
  try {
    let answer: Answer;
    try {
      answer = await search(api, query);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 400 && error.message.includes('api must be') && query.trim() === '')) throw error;
      // A provider's name sent as the API: the plans whose provider or plan name holds it.
      [api, query] = ['', api];
      answer = await search(api, query);
      notes.push(`No API is named ${JSON.stringify(input.api)}: these are the plans whose provider or plan name holds it.`);
    }
    if (answer.total === 0 && query.includes('-')) {
      // A slug sent as a name, like bright-data, which no name holds: its words, like bright data. A name with a
      // hyphen, like A-Leads, is found as it is first.
      const words = query.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ');
      try {
        answer = await search(api, words);
        notes.push(`No provider's or plan's name holds ${JSON.stringify(query)}: these are the plans whose name holds ${JSON.stringify(words)}.`);
      } catch {
        // The first answer stands.
      }
    }
    return { ...answer, plans: briefPlans(answer.plans), ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
  } catch (error) {
    return asResult(error);
  }
}

async function providerRun(client: Client, { slug }: ProviderInput, signal?: AbortSignal): Promise<Answer> {
  if (PLACEHOLDER.test(slug ?? '')) {
    return { error: `${JSON.stringify(slug)} is a placeholder. Give the provider's own slug or name, like bright-data or Bright Data.` };
  }
  const provider = slugify(slug ?? '');
  if (provider === '') return { error: "Give a provider's slug or name, like bright-data or Bright Data" };
  let answer: Answer;
  try {
    answer = await client.get(`/providers/${provider}`, {}, signal);
  } catch (error) {
    // An API's slug sent as a provider's, like email-finder: the API's words, and where an API's best providers are.
    if (error instanceof ApiError && error.status === 404) return { error: `${error.message}. ${FOR_API}` };
    return asResult(error);
  }
  const apis = objects(answer.apis).map((entry) => {
    const plans = objects(entry.plans);
    const kept: Answer = { ...brief(entry, ['api', 'slug', 'rank', 'bestPage']), plans: plans.length };
    const best = bestPlan(plans);
    if (best) kept.best = brief(best, ['plan', 'score', 'perThousand', 'page']);
    return kept;
  });
  // Its best rank first, the APIs where it has none last, in the API's order.
  const rank = (api: Answer) => (typeof api.rank === 'number' ? api.rank : Infinity);
  apis.sort((a, b) => rank(a) - rank(b));
  return { ...answer, apis, total: apis.length, ranked: apis.filter((api) => typeof api.rank === 'number').length };
}

/** A provider's best plan on an API: its lowest rank, the first when none has a rank. */
function bestPlan(plans: Answer[]): Answer | undefined {
  const ranked = plans.filter((plan) => typeof plan.rank === 'number');
  if (ranked.length === 0) return plans[0];
  return ranked.reduce((best, plan) => ((plan.rank as number) < (best.rank as number) ? plan : best));
}

/** A JSON value, as the SDK's document type (a tool's input schema, a tool use's input) takes it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A property of a tool's input schema. */
export type DatacircleProperty = { type: string; description: string; enum?: string[]; minimum?: number; maximum?: number };

/** A tool's input schema as the model is sent it: a JSON schema of an object, its needed keys required. */
export type DatacircleSchema = { type: 'object'; properties: Record<string, DatacircleProperty>; required?: string[] };

/** The four tools' names, in their order. Their answers name each other by these names. */
export type ToolName = 'datacircle_list_apis' | 'datacircle_best_plans' | 'datacircle_search_plans' | 'datacircle_provider';

/** A tool for toolConfig.tools of ConverseCommand and ConverseStreamCommand (the SDK's Tool): a tool spec, its input schema a JSON schema. */
export interface DatacircleTool<Name extends ToolName = ToolName> {
  toolSpec: { name: Name; description: string; inputSchema: { json: DatacircleSchema } };
}

/** A toolUse block's tool use, as the SDK's ToolUseBlock gives it: in output.message.content of Converse, or gathered from a stream. */
export interface ToolUse {
  toolUseId?: string;
  name?: string;
  input?: unknown;
  /** server_tool_use for a system tool's use, which Bedrock runs itself. */
  type?: string;
}

/** A message of the conversation, as the SDK's Message is: the model's message, whose tool uses runToolUses answers. */
export interface ConverseMessage {
  role?: string;
  content?: readonly unknown[];
}

/** A toolResult block that answers one tool use: its text the tool's answer as JSON. */
export interface ToolResultBlock {
  toolResult: { toolUseId: string; content: { text: string }[] };
}

/** The user message that answers each tool use of the model's message, for the next request's messages. */
export interface ToolResultMessage {
  role: 'user';
  content: ToolResultBlock[];
}

/** One of the app's own tools' uses, for the app to answer. */
export interface OwnToolUse {
  toolUseId: string;
  name: string;
  input: any;
}

/**
 * Answers a use of one of the app's own tools: text (often JSON) as it is, any other value as JSON. What it throws is
 * the model's to read, as {"error": "..."}.
 */
export type OwnTool = (use: OwnToolUse, signal?: AbortSignal) => unknown;

/** Where the tools call, and the signal that stops a call (the app's own stop). */
export interface RunOptions extends DatacircleOptions {
  signal?: AbortSignal;
}

/** runToolUses' options: RunOptions, and the function that answers the app's own tools. */
export interface RunToolUsesOptions extends RunOptions {
  /**
   * Answers each use of another tool than the four. Bedrock wants every tool use of a turn answered in the next
   * message: left out, the model reads {"error": "No tool is named ... here."} for each.
   */
  own?: OwnTool;
}

interface Spec {
  name: ToolName;
  description: string;
  schema: Input;
  run: (client: Client, input: never, signal?: AbortSignal) => Promise<Answer>;
}

const SPECS: Spec[] = [
  { name: 'datacircle_list_apis', description: LIST_APIS_ABOUT, schema: listApisInput, run: listApisRun },
  { name: 'datacircle_best_plans', description: BEST_PLANS_ABOUT, schema: bestPlansInput, run: bestPlansRun },
  { name: 'datacircle_search_plans', description: SEARCH_PLANS_ABOUT, schema: searchPlansInput, run: searchPlansRun },
  { name: 'datacircle_provider', description: PROVIDER_ABOUT, schema: providerInput, run: providerRun },
];

/** The four tools' names, in the order datacircleTools gives them. */
export const toolNames: readonly ToolName[] = SPECS.map((spec) => spec.name);

/**
 * The four tools, for toolConfig: { tools: datacircleTools() } of ConverseCommand and ConverseStreamCommand:
 * datacircle_list_apis (GET /apis), datacircle_best_plans (GET /apis/{slug}/best), datacircle_search_plans (GET /plans)
 * and datacircle_provider (GET /providers/{slug}). Plain objects, a new copy at each call: they can go beside the app's own tools.
 */
export function datacircleTools(): DatacircleTool[] {
  return SPECS.map(({ name, description, schema }) => ({ toolSpec: { name, description, inputSchema: { json: structuredClone(schema.json) } } }));
}

/** Whether a tool use's name is one of the four tools'. */
export function isDatacircleTool(name: unknown): name is ToolName {
  return SPECS.some((spec) => spec.name === name);
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The tool uses of the model's message that the app answers, in order: each toolUse block, but a system tool's, which
 * Bedrock runs itself (its type server_tool_use, or answered by a toolResult block of the same message).
 */
export function toolUses(message: ConverseMessage | null | undefined): ToolUse[] {
  const blocks = (message?.content ?? []).map(record).filter((block) => block !== undefined);
  const answered = new Set(blocks.map((block) => record(block.toolResult)?.toolUseId).filter((id) => typeof id === 'string'));
  return blocks
    .map((block) => record(block.toolUse) as ToolUse | undefined)
    .filter((use): use is ToolUse => use !== undefined && use.type !== 'server_tool_use' && !answered.has(use.toolUseId ?? ''));
}

/** A toolResult of one text block. A blank text is sent as {}: Bedrock refuses a blank one. */
function textResult(toolUseId: unknown, text: string): ToolResultBlock {
  return { toolResult: { toolUseId: typeof toolUseId === 'string' ? toolUseId : '', content: [{ text: text.trim() === '' ? '{}' : text }] } };
}

const errorText = (error: unknown) => JSON.stringify({ error: error instanceof Error ? error.message : String(error) });

async function answer(spec: Spec, input: unknown, options: RunOptions): Promise<Answer> {
  // Converse gives a tool use's input as an object. JSON text, as an app's own code may hold it, is read as one.
  if (typeof input === 'string') {
    try {
      input = input.trim() === '' ? {} : JSON.parse(input);
    } catch (error) {
      return { error: `The input is not JSON: ${(error as Error).message}` };
    }
  }
  const checked = spec.schema.check(input ?? {});
  // What the model reads when its input does not fit the schema: each refused key and why, so that it can call again.
  if ('refused' in checked) return { error: `The input does not fit the tool's input schema: ${checked.refused.join('; ')}` };
  const { signal, ...where } = options;
  try {
    return await spec.run(new Client(where), checked.data as never, signal);
  } catch (error) {
    // The app's stop stops the call. Anything else (the network, a 5xx) is the model's to read, and the chat goes on.
    if (signal?.aborted) throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs one tool use of the model's message, if it is one of the four tools', into the toolResult block that answers
 * it. A use of another tool gives undefined, for the app to run its own. Only the app's stop throws: an answer of 4xx,
 * an input that does not fit or a failed network is the model's to read, as {"error": "..."}.
 */
export async function runToolUse(use: ToolUse, options: RunOptions = {}): Promise<ToolResultBlock | undefined> {
  const spec = SPECS.find((spec) => spec.name === use?.name);
  if (spec === undefined) return undefined;
  return textResult(use.toolUseId, JSON.stringify(await answer(spec, use.input, options)));
}

/**
 * Answers each tool use of the model's message, in order, in one user message of toolResult blocks, for the next
 * ConverseCommand's or ConverseStreamCommand's messages: the four tools' uses by runToolUse, the others by options.own.
 * Gives undefined when the message has no tool use to answer: it is the model's answer.
 */
export async function runToolUses(message: ConverseMessage | null | undefined, options: RunToolUsesOptions = {}): Promise<ToolResultMessage | undefined> {
  const uses = toolUses(message);
  if (uses.length === 0) return undefined;
  const { own, ...where } = options;
  const content = await Promise.all(uses.map(async (use) => {
    const ours = await runToolUse(use, where);
    if (ours !== undefined) return ours;
    if (own === undefined) return textResult(use.toolUseId, errorText(`No tool is named ${JSON.stringify(use.name ?? '')} here.`));
    try {
      const value = await own({ toolUseId: use.toolUseId ?? '', name: use.name ?? '', input: use.input }, where.signal);
      return textResult(use.toolUseId, typeof value === 'string' ? value : value === undefined ? '{}' : JSON.stringify(value));
    } catch (error) {
      if (where.signal?.aborted) throw error;
      return textResult(use.toolUseId, errorText(error));
    }
  }));
  return { role: 'user', content };
}

/** An event of ConverseStreamCommand's response.stream, as the SDK's ConverseStreamOutput gives it. */
export interface StreamEvent {
  messageStart?: { role?: string };
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: { toolUse?: { toolUseId?: string; name?: string; type?: string }; toolResult?: { toolUseId?: string; type?: string; status?: string } };
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: {
      text?: string;
      toolUse?: { input?: string };
      reasoningContent?: { text?: string; signature?: string; redactedContent?: Uint8Array };
      toolResult?: readonly { text?: string; json?: unknown }[];
    };
  };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: string };
  metadata?: { usage?: unknown; metrics?: unknown };
}

/** A content block of the model's message, as a stream's events make it. */
export type AssistantBlock =
  | { text: string }
  | { reasoningContent: { reasoningText: { text: string; signature?: string } } | { redactedContent: Uint8Array } }
  | { toolUse: { toolUseId: string; name: string; input: { [key: string]: Json }; type?: 'server_tool_use' } }
  | { toolResult: { toolUseId: string; content: ({ text: string } | { json: Json })[]; type?: string; status?: 'success' | 'error' } };

/** The model's message, as a stream's events make it: what Converse gives in output.message. */
export interface AssistantMessage {
  role: 'assistant';
  content: AssistantBlock[];
}

/** One content block of the stream, by its contentBlockIndex. */
interface Streamed {
  text: string;
  reasoning: string;
  signature: string;
  redacted: Uint8Array[];
  input: string;
  use?: { toolUseId: string; name: string; type?: string };
  result?: { toolUseId: string; type?: string; status?: string; content: ({ text: string } | { json: Json })[] };
}

/**
 * Gathers ConverseStreamCommand's events into the model's message, as Converse gives it: its text, its reasoning, with
 * the signature Bedrock wants back beside a tool use, and each tool use, whose input comes in pieces of JSON. Other
 * blocks (images, citations) are left out.
 */
export class MessageCollector {
  /** The stream's stop reason, from its messageStop event: tool_use when the model used tools. */
  stopReason?: string;
  /** The stream's usage and metrics, from its metadata event. */
  metadata?: { usage?: unknown; metrics?: unknown };
  private readonly blocks = new Map<number, Streamed>();

  private block(index: number | undefined): Streamed {
    const i = typeof index === 'number' ? index : 0;
    let block = this.blocks.get(i);
    if (block === undefined) this.blocks.set(i, (block = { text: '', reasoning: '', signature: '', redacted: [], input: '' }));
    return block;
  }

  /**
   * Takes the stream's next event and gives the text it adds to the model's answer, '' for none, for an app that shows
   * the answer as it comes. An error event of the stream (a throttling, a validation...) is thrown.
   */
  add(event: StreamEvent): string {
    for (const [key, value] of Object.entries(event ?? {})) {
      if (key.endsWith('Exception') && value) {
        const message = record(value)?.message;
        throw Object.assign(new Error(typeof message === 'string' ? message : key), { name: key[0].toUpperCase() + key.slice(1) });
      }
    }
    const start = event?.contentBlockStart;
    if (start?.start?.toolUse) {
      const { toolUseId, name, type } = start.start.toolUse;
      this.block(start.contentBlockIndex).use = { toolUseId: toolUseId ?? '', name: name ?? '', ...(type ? { type } : {}) };
    } else if (start?.start?.toolResult) {
      const { toolUseId, type, status } = start.start.toolResult;
      this.block(start.contentBlockIndex).result = { toolUseId: toolUseId ?? '', ...(type ? { type } : {}), ...(status ? { status } : {}), content: [] };
    }
    const delta = event?.contentBlockDelta;
    if (delta?.delta) {
      const block = this.block(delta.contentBlockIndex);
      const { text, toolUse, reasoningContent, toolResult } = delta.delta;
      if (typeof text === 'string') {
        block.text += text;
        return text;
      }
      if (typeof toolUse?.input === 'string') block.input += toolUse.input;
      if (reasoningContent) {
        if (typeof reasoningContent.text === 'string') block.reasoning += reasoningContent.text;
        if (typeof reasoningContent.signature === 'string') block.signature += reasoningContent.signature;
        if (reasoningContent.redactedContent) block.redacted.push(reasoningContent.redactedContent);
      }
      for (const part of toolResult ?? []) {
        block.result ??= { toolUseId: '', content: [] };
        const last = block.result.content.at(-1);
        if (typeof part.text === 'string') {
          if (last !== undefined && 'text' in last) last.text += part.text;
          else block.result.content.push({ text: part.text });
        } else if (part.json !== undefined) block.result.content.push({ json: part.json as Json });
      }
    }
    if (event?.messageStop) this.stopReason = event.messageStop.stopReason;
    if (event?.metadata) this.metadata = event.metadata;
    return '';
  }

  /**
   * The model's message the events make, for the next request's messages and for runToolUses. A tool use's input that
   * is no JSON object, like none at all, is given as {}: Bedrock takes only an object. A blank text is left out, as
   * Bedrock refuses it.
   */
  message(): AssistantMessage {
    const content: AssistantBlock[] = [];
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.use !== undefined) {
        let input: unknown;
        try {
          input = JSON.parse(block.input);
        } catch {
          input = undefined;
        }
        const { toolUseId, name, type } = block.use;
        content.push({ toolUse: { toolUseId, name, input: (record(input) ?? {}) as { [key: string]: Json }, ...(type === 'server_tool_use' ? { type } : {}) } });
      } else if (block.result !== undefined) {
        const { toolUseId, type, status, content: parts } = block.result;
        if (parts.length > 0) {
          content.push({ toolResult: { toolUseId, content: parts, ...(type ? { type } : {}), ...(status === 'success' || status === 'error' ? { status } : {}) } });
        }
      } else if (block.redacted.length > 0) {
        const redactedContent = new Uint8Array(block.redacted.reduce((n, piece) => n + piece.length, 0));
        let at = 0;
        for (const piece of block.redacted) {
          redactedContent.set(piece, at);
          at += piece.length;
        }
        content.push({ reasoningContent: { redactedContent } });
      } else if (block.reasoning !== '' || block.signature !== '') {
        content.push({ reasoningContent: { reasoningText: { text: block.reasoning, ...(block.signature !== '' ? { signature: block.signature } : {}) } } });
      } else if (block.text.trim() !== '') {
        content.push({ text: block.text });
      }
    }
    return { role: 'assistant', content };
  }
}

/**
 * Reads ConverseStreamCommand's response.stream to its end and gives the model's message its events make, as Converse
 * gives it. onText gets each piece of the answer's text as it comes, for an app that shows it. An error event of the
 * stream is thrown.
 */
export async function collectStream(stream: AsyncIterable<StreamEvent> | null | undefined, onText?: (text: string) => void): Promise<AssistantMessage> {
  if (stream === undefined || stream === null) throw new Error('datacircle: no stream: give collectStream the response.stream of ConverseStreamCommand');
  const collector = new MessageCollector();
  for await (const event of stream) {
    const text = collector.add(event);
    if (text !== '' && onText) onText(text);
  }
  return collector.message();
}

// The same calls without a model: each gives the answer the model would read, as an object, an answer of 4xx as {error}.

/** GET /apis: the APIs, as datacircle_list_apis gives them. */
export const listApis = (input: ListApisInput = {}, options?: DatacircleOptions) => listApisRun(new Client(options), input);

/** GET /apis/{slug}/best: an API's plans best first, as datacircle_best_plans gives them. */
export const bestPlans = (input: BestPlansInput, options?: DatacircleOptions) => bestPlansRun(new Client(options), input);

/** GET /plans: the plans found, as datacircle_search_plans gives them. */
export const searchPlans = (input: SearchPlansInput = {}, options?: DatacircleOptions) => searchPlansRun(new Client(options), input);

/** GET /providers/{slug}: where a provider ranks, as datacircle_provider gives it. */
export const providerRanks = (input: ProviderInput, options?: DatacircleOptions) => providerRun(new Client(options), input);
