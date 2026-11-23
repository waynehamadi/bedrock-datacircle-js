// The package from CommonJS: require gives the same tools, and a call of each kind runs on the live API.
const { datacircleTools, runToolUses, collectStream, bestPlans, VERSION } = require('@datacircle/bedrock');

(async () => {
  const tools = datacircleTools();
  const answer = await runToolUses({ role: 'assistant', content: [{ toolUse: { toolUseId: 'tooluse_1', name: 'datacircle_best_plans', input: { slug: 'serp', limit: 2 } } }] });
  const plans = JSON.parse(answer.content[0].toolResult.content[0].text).plans;
  const message = await collectStream((async function* () { yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'ok' } } }; })());
  const alone = await bestPlans({ slug: 'serp', limit: 1 });
  const ok = answer.content[0].toolResult.toolUseId === 'tooluse_1' && plans?.length === 2 && message.content[0].text === 'ok' && alone.plans?.length === 1 && VERSION === '0.1.0';
  console.log(`${ok ? 'ok  ' : 'FAIL'} require: ${tools.map((t) => t.toolSpec.name).join(',')}; serp ${plans?.map((p) => p.provider).join(' / ')}`);
  process.exit(ok ? 0 : 1);
})();
