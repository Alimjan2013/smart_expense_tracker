import { Hono } from "hono";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = new Hono();



app.get("/", async (c) => {
  const response = await openai.responses.create({
    model: "gpt-4.1-nano",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: 'Extract structured financial transaction data from a screenshot of a bank app transaction record.\n\nCarefully examine the screenshot and extract the following fields from each transaction:\n- Time (时间)\n- Amount (金额)\n- Currency (币种)\n- Purpose or transaction description (用途)\n\n# Steps\n- Analyze the screenshot to understand the layout and identify each transaction record.\n- For each transaction, extract the relevant fields: time, amount, currency, and purpose.\n- Ensure that the extracted data is complete and accurately reflects the information in the screenshot.\n\n# Output Format\nReturn the extracted transaction data as a JSON array, where each transaction is a JSON object containing the following fields:\n\n- "time": [date]\n- "amount": [number or string, as given]\n- "currency": [string]\n- "purpose": [string]\n\nExample:\n[\n  {\n    "time": "2023-06-01 14:30",\n    "amount": "1000.00",\n    "currency": "CNY",\n    "purpose": "ATM Withdrawal"\n  },\n  {\n    "time": "2023-06-01 16:01",\n    "amount": "-25.00",\n    "currency": "CNY",\n    "purpose": "Coffee Shop"\n  }\n]\n(Real examples should use real data directly extracted from the screenshot.)\n\n# Notes\n- If any field is missing or unclear for a transaction, fill its value with [unclear].\n- Do not include any extra explanation or commentary—output the JSON only.\n- If the image is too blurry or cannot be read, output an empty array: [].\n\n[Reminder: Your objective is to extract all available transaction records from the screenshot and present them accurately and succinctly in the specified JSON format.]',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Uber Eats
Pending
742.52 SEK
Uber Eats
Eating out
If the merchant doesn't claim this payment by August 29, 2025, we'll automatically return your money.
Learn more
Split this transaction
Request money from others
AA &
Transaction details
When
Where
Which card
Authorised via
22 August 2025 at 13:11
Online
9032
Apple Pay
Pay`,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_object",
      },
    },
    reasoning: {},
    tools: [],
    temperature: 1,
    max_output_tokens: 2048,
    top_p: 1,
    store: true,
  });
  return c.json(JSON.parse(response.output_text));
});

app.post("/", async (c) => {
  const body = await c.req.json();
  console.log("body", body.text);
  const text = body.text;
  const response = await openai.responses.create({
    model: "gpt-4.1-nano",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: 'Extract structured financial transaction data from a screenshot ocr result of a bank app transaction record.\n\nCarefully examine the screenshot and extract the following fields from each transaction:\n- Time (时间)\n- Amount (金额)\n- Currency (币种)\n- Purpose or transaction description (用途)\n\n# Steps\n- Analyze the screenshot to understand the layout and identify each transaction record.\n- For each transaction, extract the relevant fields: time, amount, currency, and purpose.\n- Ensure that the extracted data is complete and accurately reflects the information in the screenshot.\n\n# Output Format\nReturn the extracted transaction data as a JSON array, where each transaction is a JSON object containing the following fields:\n\n- "time": [date]\n- "amount": [number or string, as given]\n- "currency": [string]\n- "purpose": [string]\n\nExample:\n[\n  {\n    "time": "2023-06-01 14:30",\n    "amount": "1000.00",\n    "currency": "CNY",\n    "purpose": "ATM Withdrawal"\n  },\n  {\n    "time": "2023-06-01 16:01",\n    "amount": "-25.00",\n    "currency": "CNY",\n    "purpose": "Coffee Shop"\n  }\n]\n(Real examples should use real data directly extracted from the screenshot.)\n\n# Notes\n- If any field is missing or unclear for a transaction, fill its value with [unclear].\n- Do not include any extra explanation or commentary—output the JSON only.\n- If the image is too blurry or cannot be read, output an empty array: [].\n\n[Reminder: Your objective is to extract all available transaction records from the screenshot and present them accurately and succinctly in the specified JSON format.]',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: text,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_object",
      },
    },
    reasoning: {},
    tools: [],
    temperature: 1,
    max_output_tokens: 2048,
    top_p: 1,
    store: true,
  });
  const result = JSON.parse(response.output_text); 
  if (result.currency) {
    const conversionRate = await getCurrencyConversionRate(result.currency, "EUR");
    result.amount = convertCurrency(result.amount, conversionRate);
    result.currency = "EUR";
  }
  return c.json(result);
});

// --- Currency helpers ---
async function getCurrencyConversionRate(from: string, to: string): Promise<number> {
  const base = from?.toUpperCase();
  const target = to?.toUpperCase();
  if (!base || !target) throw new Error("Both from and to currencies are required");
  if (base === target) return 1;
  const apiKey = process.env.currency_API_KEY || process.env.CURRENCY_API_KEY;
  if (!apiKey) throw new Error("currency_API_KEY env var not set");
  const url = `https://api.currencyapi.com/v3/latest?apikey=${apiKey}&currencies=${encodeURIComponent(target)}&base_currency=${encodeURIComponent(base)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Currency API error ${res.status}: ${txt}`);
  }
  const data: any = await res.json();
  const value = data?.data?.[target]?.value;
  if (typeof value !== "number") throw new Error("Unexpected currency API response structure");
  return value;
}

function convertCurrency(amount: string | number, rate: number): number {
  if (rate === 1) return toNumber(amount);
  const numeric = toNumber(amount);
  const converted = numeric * rate;
  return Math.round((converted + Number.EPSILON) * 100) / 100;
}

function toNumber(a: string | number): number {
  if (typeof a === "number") return a;
  const cleaned = a.replace(/[^0-9+\-.,]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Invalid amount: ${a}`);
  return n;
}

export default app;
