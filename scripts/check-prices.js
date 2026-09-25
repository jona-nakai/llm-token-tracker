// Compares prices.json with LiteLLM's community price table and reports any
// rate that differs, so price changes are easy to spot. Nothing is written.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FIELDS = {
  input: 'input_cost_per_token',
  cacheWrite: 'cache_creation_input_token_cost',
  cacheWrite1h: 'cache_creation_input_token_cost_above_1hr',
  cacheRead: 'cache_read_input_token_cost',
  output: 'output_cost_per_token',
};

const prices = JSON.parse(readFileSync(fileURLToPath(new URL('../prices.json', import.meta.url)), 'utf8'));
const response = await fetch(LITELLM_URL);
if (!response.ok) {
  console.error(`Could not fetch ${LITELLM_URL}: ${response.status}`);
  process.exit(1);
}
const reference = await response.json();

let differences = 0;
let missing = 0;
for (const [key, model] of Object.entries(prices.models)) {
  const ref = reference[key];
  if (!ref) {
    missing += 1;
    console.log(`?  ${key}: not in LiteLLM`);
    continue;
  }
  for (const [field, refField] of Object.entries(FIELDS)) {
    if (model[field] === undefined || ref[refField] === undefined) continue;
    const refValue = Math.round(ref[refField] * 1e6 * 1e6) / 1e6;
    if (Math.abs(refValue - model[field]) > 1e-9) {
      differences += 1;
      console.log(`≠  ${key}.${field}: prices.json ${model[field]} vs LiteLLM ${refValue}`);
    }
  }
}
console.log(`\n${Object.keys(prices.models).length} models checked, ${differences} differing rates, ${missing} not in LiteLLM.`);
console.log(`prices.json last checked ${prices.checkedAt}. Confirm changes against ${prices.sources.anthropic} and ${prices.sources.openai}.`);
