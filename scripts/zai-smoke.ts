// Checks that the Z.ai key works for what the tone researcher needs:
//   1. the standalone Web Search API
//   2. GLM-5.3-Flash calling a search_web function tool and using the result
//
//   node --env-file=.env --experimental-strip-types scripts/zai-smoke.ts

const BASE = "https://api.z.ai/api/paas/v4";
const MODEL = process.env.ZAI_MODEL ?? "glm-5.3-flash";
const key = process.env.ZAI_API_KEY;
if (!key) {
  console.error("ZAI_API_KEY is empty: put your key in .env");
  process.exit(1);
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

interface SearchHit { title: string; link: string; content: string }

// The docs disagree on the engine id, so try both.
async function search(query: string): Promise<{ engine: string; hits: SearchHit[] }> {
  let lastError: unknown;
  for (const engine of ["search-prime", "search_pro_jina"]) {
    try {
      const result = await post("/web_search", { search_engine: engine, search_query: query, count: 5 });
      return { engine, hits: result.search_result ?? [] };
    } catch (error) {
      lastError = error;
      console.log(`  engine ${engine} failed: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

const query = "Kill the King Megadeth guitar tone amp gear recording";
console.log(`1) Web Search API: "${query}"`);
const { engine, hits } = await search(query);
console.log(`  engine ${engine} works, ${hits.length} results`);
for (const hit of hits) console.log(`  - ${hit.title} | ${hit.link}`);

console.log(`\n2) ${MODEL} with a search_web tool`);
const tools = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web. Use it to find guitar gear, rig rundowns and interviews.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
];
const messages: unknown[] = [
  {
    role: "user",
    content:
      "What amp and pedals did Megadeth use for the rhythm guitar on 'Kill the King' (1998)? " +
      "Search first, then answer in 3 lines and cite the URLs you used.",
  },
];

for (let turn = 1; turn <= 4; turn++) {
  const reply = await post("/chat/completions", { model: MODEL, messages, tools, tool_choice: "auto", max_tokens: 4000 });
  const message = reply.choices[0].message;
  messages.push(message);
  const calls = message.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`  final answer (turn ${turn}):\n${message.content}`);
    console.log(`  tokens: ${JSON.stringify(reply.usage)}`);
    break;
  }
  for (const call of calls) {
    const { query: q } = JSON.parse(call.function.arguments);
    console.log(`  turn ${turn}: model called search_web("${q}")`);
    const found = await search(q);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(found.hits.map((h) => ({ title: h.title, link: h.link, content: h.content }))),
    });
  }
}
