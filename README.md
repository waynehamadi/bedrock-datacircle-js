# Datacircle tools for Amazon Bedrock in the AWS SDK for JavaScript

Find the best GTM APIs. We benchmark all the GTM APIs and we put the results on our website.

Our website: https://datacircle.dev

This package gives Amazon Bedrock's Converse API four tools that call Datacircle's open API, https://api.datacircle.dev/v1. You pass the tools to `ConverseCommand` or `ConverseStreamCommand` of the [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3). Bedrock does not run tools. This package runs each call the model makes to a Datacircle tool. You get the answers to send back to the model. You need no key and no account.

| Tool | What the tool gives | Call |
| --- | --- | --- |
| `datacircle_list_apis` | Every GTM API on Datacircle, with the API's slug, number of plans, number of providers and best plan | `GET /apis` |
| `datacircle_best_plans` | One API's plans, sorted by score out of 100, best first. Each plan comes with a rank and a price per 1,000 calls | `GET /apis/{slug}/best` |
| `datacircle_search_plans` | Plans that match a provider or plan name, on all APIs or on one API. You can sort them by score, provider or price | `GET /plans` |
| `datacircle_provider` | The APIs a provider sells, and the provider's rank on each API | `GET /providers/{slug}` |

## Install

```bash
npm install @datacircle/bedrock @aws-sdk/client-bedrock-runtime
```

The package needs Node.js 20 or later. `@aws-sdk/client-bedrock-runtime` must be 3.587.0 or later. The TypeScript types need `@aws-sdk/client-bedrock-runtime` 3.755.0 or later. You can load the package with `import` or `require`.

## Use the tools with Converse

Put `datacircleTools()` in `toolConfig`. Add the model's message to your messages. Then add the user message that `runToolUses` returns:

```js
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { datacircleTools, runToolUses } from '@datacircle/bedrock';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });
const messages = [{ role: 'user', content: [{ text: 'Who are the 3 best providers for the email-finder API?' }] }];

while (true) {
  const response = await client.send(new ConverseCommand({
    modelId: 'amazon.nova-pro-v1:0',
    messages,
    toolConfig: { tools: datacircleTools() },
  }));
  const message = response.output.message;
  messages.push(message);
  const answers = await runToolUses(message);
  if (!answers) {
    console.log(message.content.map((block) => block.text ?? '').join(''));
    break;
  }
  messages.push(answers);
}
```

`runToolUses` returns one user message with a `toolResult` for each tool the model used. `runToolUses` keeps the order of the model's tool uses. You get `undefined` when the model used no tool.

## Use the tools with ConverseStream

`collectStream` reads the stream to the end and gives the model's message. Pass a function to print the text during the stream:

```js
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { collectStream } from '@datacircle/bedrock';

while (true) {
  const response = await client.send(new ConverseStreamCommand({
    modelId: 'amazon.nova-pro-v1:0',
    messages,
    toolConfig: { tools: datacircleTools() },
  }));
  const message = await collectStream(response.stream, (text) => process.stdout.write(text));
  messages.push(message);
  const answers = await runToolUses(message);
  if (!answers) break;
  messages.push(answers);
}
```

The message holds the text, the reasoning and each tool use. The reasoning keeps the model's signature. Bedrock needs that signature back when the model reasons before a tool call. The stream sends each tool input in pieces of JSON. The message holds the whole input. An empty input is `{}`. If the stream sends an error event, `collectStream` throws that error.

To read the events in your own loop, give each event to a `MessageCollector`. `add` gives the text of the event. After the stream ends, `message()` gives the model's message. `stopReason` holds the stream's stop reason. `metadata` holds the token counts:

```js
import { MessageCollector } from '@datacircle/bedrock';

const collector = new MessageCollector();
for await (const event of response.stream) {
  process.stdout.write(collector.add(event));
}
const message = collector.message();
```

## Your own tools

Bedrock needs an answer to each tool the model used in a turn. If you add tools of your own, pass an `own` function to `runToolUses`. The function gets each use of one of your tools. Return text or any other value. We send each value other than text as JSON. If the function throws, the model reads `{"error": "..."}`:

```js
const getTime = {
  toolSpec: {
    name: 'get_time',
    description: 'The time in a time zone',
    inputSchema: { json: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] } },
  },
};
const toolConfig = { tools: [...datacircleTools(), getTime] };

const answers = await runToolUses(message, {
  own: async (use) => ({ time: '12:00', zone: use.input.zone }),
});
```

Without `own`, the model reads an error for each use of one of your tools. `isDatacircleTool(name)` tells you if the tool named `name` is one of ours. `runToolUse(use)` answers one use of a Datacircle tool with a `toolResult` block. For any other tool, `runToolUse` returns `undefined`. `toolUses(message)` lists the tool uses in a message for your code to answer. The list leaves out system tools. Bedrock answers system tools itself.

## Make each call yourself

You can make each call without a model. Each function returns the result as an object:

```js
import { bestPlans, listApis, providerRanks, searchPlans } from '@datacircle/bedrock';

const best = await bestPlans({ slug: 'email-finder', limit: 3 });
const brightData = await providerRanks({ slug: 'Bright Data' });
```

## What the model reads

Each tool gives the model a JSON object as the text of the `toolResult`. Each plan comes with a rank, provider, plan, score, price per 1,000 (`perThousand`, in dollars) and a page on datacircle.dev. That page lists every field. Each tool also takes an API's name or a provider's name in place of a slug.

For an unknown slug, the model reads `{"error": "..."}` with the API's message and what to send instead. If the network fails, the error gives the network's message. The model can read the error, call the tool again and keep going.

The options of `runToolUses` and `runToolUse` take a `signal`, an `AbortSignal` that stops the calls. Only an abort throws. Every other error comes back to the model as JSON. The options also take your own `fetch`. Your `fetch` can add a proxy or a timeout.

## Network

Each tool call sends HTTPS GET requests to https://api.datacircle.dev/v1 and nowhere else. Most calls send one request. `datacircle_search_plans` sends up to three when the first search finds nothing. The requests hold only the tool's input from the model: no key and nothing from your messages. The API takes up to 60 calls a minute from one IP address. The tool waits once, for a minute at most, when the API says to wait. The package has no dependencies and stores nothing.

## Links

- Datacircle: https://datacircle.dev
- The API: https://datacircle.dev/api
- The API's spec: https://api.datacircle.dev/v1/openapi.json
- What each key means: https://datacircle.dev/fields

MIT license.
