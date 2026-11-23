// Each tool's call on the live API, as an app runs it after ConverseCommand: the model's toolUse block, through
// runToolUse, into the toolResult block the model reads next; the answers a model's mistakes get; and a stream's events
// gathered into the model's message. npm test
import { MessageCollector, bestPlans, collectStream, datacircleTools, isDatacircleTool, listApis, providerRanks, runToolUse, runToolUses,
  searchPlans, toolNames, toolUses } from '@datacircle/bedrock';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
};
// A tool use as Converse gives it in output.message.content (its input an object), run into its toolResult block; the
// answer the model reads.
let uses = 0;
const run = async (name, input, options) => {
  const toolUseId = `tooluse_${++uses}`;
  const block = await runToolUse({ toolUseId, name, input }, options);
  const result = block?.toolResult;
  if (Object.keys(block).join() !== 'toolResult' || result.toolUseId !== toolUseId || Object.keys(result).join() !== 'toolUseId,content'
    || result.content.length !== 1 || Object.keys(result.content[0]).join() !== 'text') throw new Error(`bad block ${JSON.stringify(block)}`);
  return JSON.parse(result.content[0].text);
};
const [LIST, BEST, SEARCH, PROVIDER] = ['datacircle_list_apis', 'datacircle_best_plans', 'datacircle_search_plans', 'datacircle_provider'];

const NAMES = [LIST, BEST, SEARCH, PROVIDER].join(',');
const tools = datacircleTools();
check('names', tools.map((t) => t.toolSpec.name).join(',') === NAMES && toolNames.join(',') === NAMES, tools.map((t) => t.toolSpec.name).join(','));
// What Converse sends the model: a tool spec whose input schema is a JSON schema of an object, its needed keys
// required, a name Bedrock takes, and nothing that JSON drops.
for (const t of tools) {
  const s = t.toolSpec.inputSchema.json;
  check(`${t.toolSpec.name} spec`, Object.keys(t).join() === 'toolSpec' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.toolSpec.name) && s.type === 'object'
    && (s.required ?? []).every((k) => k in s.properties) && (s.required === undefined || s.required.length > 0)
    && Object.values(s.properties).every((p) => typeof p.type === 'string' && p.description)
    && t.toolSpec.description.length > 50 && JSON.stringify(JSON.parse(JSON.stringify(t))) === JSON.stringify(t),
    `required [${s.required ?? ''}] of [${Object.keys(s.properties)}]`);
}
tools[0].toolSpec.inputSchema.json.properties.query.description = 'changed';
check('each call a new copy', datacircleTools()[0].toolSpec.inputSchema.json.properties.query.description !== 'changed', 'unchanged');
check('isDatacircleTool', isDatacircleTool(BEST) && !isDatacircleTool('get_weather') && !isDatacircleTool(undefined), 'yes / no / no');

let r = await run(LIST, {});
check('list_apis', r.total > 100 && r.apis.length === 20 && r.apis[0].slug, `total ${r.total}, first ${r.apis[0]?.slug}`);
r = await run(LIST, undefined);
check('list_apis no input at all', r.apis?.length === 20, `${r.apis?.length} APIs`);
r = await run(LIST, { query: 'email', limit: '3' });
check('list_apis email, limit as a string', r.apis?.length === 3 && r.apis.every((a) => /email/i.test(a.api + a.slug)) && !r.note, r.apis?.map((a) => a.slug).join(', '));
r = await run(LIST, { query: 'Bright Data' });
check('list_apis provider name', typeof r.note === 'string' && r.note.includes('datacircle_search_plans'), r.note);
r = await run(LIST, { query: null, limit: null });
check('list_apis nulls', r.apis?.length === 20 && !r.note, `${r.apis?.length} APIs`);
r = await run(LIST, '{"query": "linkedin", "limit": 2}');
check('list_apis input as JSON text', r.apis?.length === 2, r.apis?.map((a) => a.slug).join(', '));
r = await run(LIST, [1, 2]);
check('list_apis input an array: refused', r.error === "The input does not fit the tool's input schema: expected an object, got [1,2]", r.error);
r = await run(LIST, { query: 7 });
check('list_apis query a number: refused', /: query: expected text, got 7$/.test(r.error), r.error);
r = await run(LIST, '{"query": ');
check('list_apis input not JSON', r.error?.startsWith('The input is not JSON'), r.error);

r = await run(BEST, { slug: 'email-finder', limit: 3 });
check('best_plans', r.plans.length === 3 && r.plans[0].rank === 1 && typeof r.plans[0].score === 'number' && r.plans[0].page && !('aggregators' in r.plans[0]),
  `${r.api}: ${r.plans.map((p) => `${p.rank}. ${p.provider} ${p.score}`).join(' / ')}`);
r = await run(BEST, { slug: 'Email Finder', limit: 99 });
check('best_plans name, limit 99', r.plans?.length >= 10 && r.slug === 'email-finder', `${r.plans?.length} plans`);
r = await run(BEST, { slug: 'bright-data' });
check('best_plans unknown slug', r.error?.startsWith('no API has the slug bright-data') && r.error.includes('datacircle_search_plans'), r.error);
r = await run(BEST, { slug: 'serp-api', limit: 2 });
check('best_plans slug with -api', r.slug === 'serp' && r.plans?.length === 2 && r.note?.startsWith('No API has the slug serp-api'), r.note);
r = await run(BEST, { slug: '<api-slug-here>' });
check('best_plans placeholder', r.error?.startsWith('"<api-slug-here>" is a placeholder'), r.error);
r = await run(BEST, { slug: '' });
check('best_plans empty slug', r.error?.startsWith("Give an API's slug"), r.error);
r = await run(BEST, { limit: 2 });
check('best_plans no slug: refused', /^The input does not fit the tool's input schema: slug/.test(r.error), r.error);
r = await run(BEST, { slug: 'serp', limit: 'many' });
check('best_plans limit not a number: refused', /: limit/.test(r.error), r.error);
r = await run(BEST, { slug: 'serp', limit: 2, extra: true });
check('best_plans a key of its own: dropped', r.plans?.length === 2, `${r.plans?.length} plans`);

r = await run(SEARCH, { query: 'bright data', sort: 'price', limit: 5 });
check('search_plans', r.total > 0 && r.plans.length === 5 && r.plans.every((p) => /bright data/i.test(p.provider)), `total ${r.total}, cheapest ${r.plans[0]?.perThousand}`);
r = await run(SEARCH, { api: 'email-finder', limit: 2, offset: 1 });
check('search_plans api offset', r.plans.length === 2 && r.plans[0].rank === 2, r.plans.map((p) => `${p.rank}. ${p.provider}`).join(' / '));
r = await run(SEARCH, { api: 'Bright Data' });
check('search_plans provider as api', r.total > 0 && r.note?.startsWith('No API is named'), `total ${r.total}: ${r.note}`);
r = await run(SEARCH, { query: 'bright-data' });
check('search_plans slug as query', r.total > 0 && r.note?.includes('"bright data"'), `total ${r.total}: ${r.note}`);
r = await run(SEARCH, { offset: -3, limit: 0 });
check('search_plans out of range: the defaults', r.plans?.length === 10, `${r.plans?.length} plans`);
r = await run(SEARCH, { sort: 'cheapest' });
check('search_plans bad sort: refused', /: sort/.test(r.error), r.error);

r = await run(PROVIDER, { slug: 'Bright Data' });
check('provider', r.slug === 'bright-data' && r.total > 10 && r.ranked > 0 && r.apis[0].rank <= r.apis[1].rank && r.apis[0].best?.plan,
  `${r.provider}: ${r.total} APIs, ranked on ${r.ranked}, best ${r.apis[0].api} #${r.apis[0].rank}`);
r = await run(PROVIDER, { slug: 'nobody-x' });
check('provider unknown', r.error?.startsWith('no provider has the slug nobody-x'), r.error);
r = await run(PROVIDER, { slug: 'email-finder' });
check("provider: an API's slug", r.error?.startsWith('no provider has the slug email-finder') && r.error.includes('datacircle_best_plans'), r.error);

// Another tool's use is left to the app. A model's message as Converse gives it: text, a system tool's use answered in
// the same message, ours and the app's.
check("another tool's use: undefined", (await runToolUse({ toolUseId: 'x', name: 'get_weather', input: { city: 'Paris' } })) === undefined, 'undefined');
const message = {
  role: 'assistant',
  content: [
    { text: 'Looking.' },
    { toolUse: { toolUseId: 'a', name: LIST, input: { query: 'email', limit: 1 } } },
    { toolUse: { toolUseId: 'srv', name: 'nova_grounding', input: {}, type: 'server_tool_use' } },
    { toolResult: { toolUseId: 'srv', content: [{ text: 'found' }], type: 'nova_grounding_result' } },
    { toolUse: { toolUseId: 'b', name: 'get_weather', input: { city: 'Paris' } } },
    { toolUse: { toolUseId: 'c', name: PROVIDER, input: { slug: 'bright-data' } } },
  ],
};
check('toolUses: the app answers these', toolUses(message).map((u) => u.toolUseId).join(',') === 'a,b,c', toolUses(message).map((u) => u.toolUseId).join(','));
let answer = await runToolUses(message);
const texts = (m) => m.content.map((b) => b.toolResult.content[0].text);
check('runToolUses: one user message, each use answered in order', answer.role === 'user' && answer.content.map((b) => b.toolResult.toolUseId).join(',') === 'a,b,c'
  && JSON.parse(texts(answer)[0]).apis?.length === 1 && texts(answer)[1] === '{"error":"No tool is named \\"get_weather\\" here."}' && JSON.parse(texts(answer)[2]).slug === 'bright-data',
  texts(answer).map((t) => t.slice(0, 50)).join(' | '));
answer = await runToolUses(message, { own: async (use) => (use.name === 'get_weather' ? { city: use.input.city, sky: 'sunny' } : undefined) });
check('runToolUses own: an object as JSON', texts(answer)[1] === '{"city":"Paris","sky":"sunny"}', texts(answer)[1]);
answer = await runToolUses(message, { own: () => 'Sunny' });
check('runToolUses own: text as it is', texts(answer)[1] === 'Sunny', texts(answer)[1]);
answer = await runToolUses(message, { own: () => '  ' });
check('runToolUses own: blank text is {}', texts(answer)[1] === '{}', texts(answer)[1]);
answer = await runToolUses(message, { own: () => { throw new Error('no weather'); } });
check('runToolUses own throws: {error}', texts(answer)[1] === '{"error":"no weather"}', texts(answer)[1]);
check('runToolUses of the answer: undefined', (await runToolUses({ role: 'assistant', content: [{ text: 'Done.' }] })) === undefined
  && (await runToolUses(undefined)) === undefined && (await runToolUses({ role: 'assistant' })) === undefined, 'undefined');

// A stream's events, as the SDK gives them: reasoning with its signature, text in pieces, a tool use's input in pieces,
// one with no piece at all, one whose input is no object, a system tool's use and result, an image left out, then the stop.
const events = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'The user ' } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'wants plans.' } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'c2ln' } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Call' } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'ing.' } } },
  { contentBlockStop: { contentBlockIndex: 1 } },
  { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 's1', name: BEST } } } },
  { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"slug": "email-' } } } },
  { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: 'finder", "limit": 2}' } } } },
  { contentBlockStop: { contentBlockIndex: 2 } },
  { contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: 's2', name: LIST } } } },
  { contentBlockStop: { contentBlockIndex: 3 } },
  { contentBlockStart: { contentBlockIndex: 4, start: { toolUse: { toolUseId: 's3', name: 'get_weather' } } } },
  { contentBlockDelta: { contentBlockIndex: 4, delta: { toolUse: { input: '[1]' } } } },
  { contentBlockStop: { contentBlockIndex: 4 } },
  { contentBlockStart: { contentBlockIndex: 5, start: { toolUse: { toolUseId: 'srv', name: 'nova_grounding', type: 'server_tool_use' } } } },
  { contentBlockDelta: { contentBlockIndex: 5, delta: { toolUse: { input: '{"q":"x"}' } } } },
  { contentBlockStop: { contentBlockIndex: 5 } },
  { contentBlockStart: { contentBlockIndex: 6, start: { toolResult: { toolUseId: 'srv', type: 'nova_grounding_result', status: 'success' } } } },
  { contentBlockDelta: { contentBlockIndex: 6, delta: { toolResult: [{ text: 'fou' }] } } },
  { contentBlockDelta: { contentBlockIndex: 6, delta: { toolResult: [{ text: 'nd' }] } } },
  { contentBlockStop: { contentBlockIndex: 6 } },
  { contentBlockStart: { contentBlockIndex: 7, start: { image: { format: 'png' } } } },
  { contentBlockStop: { contentBlockIndex: 7 } },
  { contentBlockDelta: { contentBlockIndex: 8, delta: { text: '  ' } } },
  { messageStop: { stopReason: 'tool_use' } },
  { metadata: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, metrics: { latencyMs: 5 } } },
];
async function* stream(list) {
  for (const event of list) yield event;
}
const shown = [];
let collected = await collectStream(stream(events), (text) => shown.push(text));
const wanted = { role: 'assistant', content: [
  { reasoningContent: { reasoningText: { text: 'The user wants plans.', signature: 'c2ln' } } },
  { text: 'Calling.' },
  { toolUse: { toolUseId: 's1', name: BEST, input: { slug: 'email-finder', limit: 2 } } },
  { toolUse: { toolUseId: 's2', name: LIST, input: {} } },
  { toolUse: { toolUseId: 's3', name: 'get_weather', input: {} } },
  { toolUse: { toolUseId: 'srv', name: 'nova_grounding', input: { q: 'x' }, type: 'server_tool_use' } },
  { toolResult: { toolUseId: 'srv', content: [{ text: 'found' }], type: 'nova_grounding_result', status: 'success' } },
] };
check('collectStream: the message', JSON.stringify(collected) === JSON.stringify(wanted), JSON.stringify(collected).slice(0, 300));
check('collectStream: onText as it comes', shown.join('|') === 'Call|ing.|  ', shown.join('|'));
answer = await runToolUses(collected, { own: () => 'sunny' });
check('collected message run', answer.content.map((b) => b.toolResult.toolUseId).join(',') === 's1,s2,s3' && JSON.parse(texts(answer)[0]).plans?.length === 2
  && JSON.parse(texts(answer)[1]).apis?.length === 20 && texts(answer)[2] === 'sunny', answer.content.map((b) => b.toolResult.toolUseId).join(','));
const collector = new MessageCollector();
const added = events.map((event) => collector.add(event)).join('');
check('MessageCollector: text, stop reason, metadata', added === 'Calling.  ' && collector.stopReason === 'tool_use' && collector.metadata?.usage?.totalTokens === 7
  && JSON.stringify(collector.message()) === JSON.stringify(wanted), `${JSON.stringify(added)} ${collector.stopReason}`);
const redacted = new MessageCollector();
redacted.add({ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } } } });
redacted.add({ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: new Uint8Array([3]) } } } });
redacted.add({ contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hi' } } });
const block = redacted.message().content[0].reasoningContent?.redactedContent;
check('redacted reasoning joined', block instanceof Uint8Array && [...block].join() === '1,2,3' && redacted.message().content[1].text === 'Hi', String(block && [...block]));
r = await collectStream(stream([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'a' } } }, { throttlingException: { message: 'Too many requests' } }])).then(() => 'no throw', (error) => error);
check('a stream error event throws', r instanceof Error && r.name === 'ThrottlingException' && r.message === 'Too many requests', `${r.name}: ${r.message}`);
r = await collectStream(undefined).then(() => 'no throw', (error) => error);
check('no stream throws', r instanceof Error && r.message.includes('response.stream'), r.message);

// The same calls without a model.
for (const [name, call] of [['listApis', () => listApis({ limit: 1 })], ['bestPlans', () => bestPlans({ slug: 'serp', limit: 1 })],
  ['searchPlans', () => searchPlans({ limit: 1 })], ['providerRanks', () => providerRanks({ slug: 'bright-data' })]]) {
  r = await call();
  check(name, !r.error && (r.apis ?? r.plans)?.length > 0, Object.keys(r).join(','));
}
r = await bestPlans({ slug: 'nope-api' });
check('bestPlans unknown: {error}', r.error?.startsWith('no API has the slug nope-api'), r.error);

// Each call's User-Agent, through a fetch of the app's own.
const seen = [];
await run(BEST, { slug: 'serp', limit: 1 }, { fetch: (url, init) => (seen.push([String(url), init.headers['User-Agent']]), fetch(url, init)) });
check('fetch option', seen.length === 1 && seen[0][0] === 'https://api.datacircle.dev/v1/apis/serp/best?limit=1' && seen[0][1] === 'datacircle-bedrock-js/0.1.0', seen.flat().join(' '));

// The app's stop stops the call: runToolUse and runToolUses throw.
const controller = new AbortController();
controller.abort(new Error('stopped'));
r = await run(BEST, { slug: 'serp' }, { signal: controller.signal }).then((answer) => answer, (error) => error);
check('abort signal', r instanceof Error && /stopped|abort/i.test(r.message), String(r?.message ?? JSON.stringify(r)));
r = await runToolUses(message, { signal: controller.signal, own: () => 'x' }).then((answer) => answer, (error) => error);
check('abort signal, runToolUses', r instanceof Error && /stopped|abort/i.test(r.message), String(r?.message ?? JSON.stringify(r)));

// A network that fails is the model's to read as {error}, never a throw, so the conversation goes on.
r = await run(BEST, { slug: 'serp' }, { baseURL: 'http://127.0.0.1:9' });
check('network down', r.error?.startsWith('datacircle:'), r.error);

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
