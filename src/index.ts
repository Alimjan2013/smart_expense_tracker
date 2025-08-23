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
  // Normalize to array of transactions (model could output single object or array)
  const transactions: any[] = Array.isArray(result) ? result : [result];

  // Convert each transaction to EUR if it has a currency & amount
  for (const tx of transactions) {
    if (tx.currency && tx.amount) {
      try {
        const rate = await getCurrencyConversionRate(tx.currency, "EUR");
        tx.amount = convertCurrency(tx.amount, rate);
        tx.currency = "EUR";
      } catch (e) {
        // Attach error but continue
        tx.conversion_error = (e as Error).message;
      }
    }
  }

  // Attempt Notion upload (ignore failure but report)
  let notionUpload: any = null;
  try {
    notionUpload = await uploadTransactionsToNotion(transactions);
  } catch (e) {
    notionUpload = { error: (e as Error).message };
  }

  return c.json({ transactions, notion: notionUpload });
});

// --- Notion helpers ---

// Plain utility to upload transaction objects to Notion (columns: Name, Price, Date)
interface TransactionRecord {
  time?: string;
  date?: string;
  amount?: number | string;
  currency?: string;
  purpose?: string;
  name?: string;
  [k: string]: any; // allow extra
}

async function uploadTransactionsToNotion(transactions: TransactionRecord | TransactionRecord[]) {
  const NOTION_TOKEN = process.env.notion_API_KEY || process.env.NOTION_API_KEY;
  const DATABASE_ID = process.env.Database_ID || process.env.DATABASE_ID;
  if (!NOTION_TOKEN) throw new Error("Missing env notion_API_KEY / NOTION_API_KEY");
  if (!DATABASE_ID) throw new Error("Missing env Database_ID / DATABASE_ID");

  const list = Array.isArray(transactions) ? transactions : [transactions];
  if (list.length === 0) return { message: "No transactions" };

  const results: { success: boolean; id?: string; error?: string }[] = [];
  for (const raw of list) {
    try {
      const name = String(raw.purpose || raw.name || 'Unknown');
      let amountVal: number | null = null;
      if (raw.amount !== undefined) {
        try { amountVal = toNumber(raw.amount); } catch { amountVal = null; }
      }
      const dateStr = extractISODate(raw.time || raw.date);
      const payload: any = {
        parent: { database_id: DATABASE_ID },
        properties: {
          Name: { title: [ { text: { content: name.slice(0, 2000) } } ] },
        },
      };
      if (amountVal !== null) payload.properties.Price = { number: amountVal };
      if (dateStr) payload.properties.Date = { date: { start: dateStr } };

      const notionResponse = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify(payload),
      });
      if (!notionResponse.ok) {
        const errorData = await notionResponse.json().catch(() => ({}));
        throw new Error(errorData?.message || `HTTP ${notionResponse.status}`);
      }
      const page = await notionResponse.json();
      results.push({ success: true, id: page.id });
    } catch (err: any) {
      results.push({ success: false, error: err?.message || String(err) });
    }
  }
  return { uploaded: results };
}

function extractISODate(input: any): string | null {
  if (!input) return null;
  if (typeof input === 'string') {
    // Try parse common patterns
    const datePartMatch = input.match(/(\d{4}-\d{2}-\d{2})/); // ISO already inside
    if (datePartMatch) return datePartMatch[1];
    // e.g., 22 August 2025 at 13:11
    const d = new Date(input.replace(/ at /i, ' '));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  if (input instanceof Date) return input.toISOString().split('T')[0];
  return null;
}
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
