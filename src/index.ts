import { Hono } from "hono";

// ------------ AI (raw HTTP) CONFIG ------------
const AI_BASE_URL =
  process.env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1"; // no trailing slash
const AI_API_KEY = process.env.AI_GATEWAY_API_KEY  // fallback
if (!AI_API_KEY)
  console.warn("AI gateway API key missing (AI_GATEWAY_API_KEY)");

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

async function chatJSON(messages: ChatMessage[], model: string) {
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Chat API error ${res.status}: ${t}`);
  }
  const data: ChatCompletionResponse = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return safeParseJSON(content);
}

const app = new Hono();

// GET demo
app.get("/", async (c) => {
  const systemPrompt =
    "Extract structured financial transaction data from text. Return JSON array of objects: time, amount, currency, purpose.";
  const userText = [
    "Uber Eats",
    "Pending",
    "742.52 SEK",
    "Uber Eats",
    "Eating out",
    "22 August 2025 at 13:11",
  ].join("\n");
  const parsed = await chatJSON(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    "openai/gpt-5-mini"
  );
  return c.json(parsed);
});

function formatDateWithOrdinal(date: Date): string {
  const day = date.getDate();
  const ordinal = 
    day === 1 || day === 21 || day === 31 ? 'st' :
    day === 2 || day === 22 ? 'nd' :
    day === 3 || day === 23 ? 'rd' : 'th';
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  
  return `${day}${ordinal} ${month} ${year}`;
}

// POST OCR processing
app.post("/", async (c) => {
  const { text } = await c.req.json();
  const today = formatDateWithOrdinal(new Date());

  const systemPrompt =
    `Extract all available structured financial transaction data from an OCR result of a bank app transaction record screenshot, presenting the information clearly in a concise and structured JSON format. Today is ${today} \n\nFirst, carefully analyze the screenshot OCR result to understand the overall layout and accurately identify the boundaries of each individual transaction. Think step-by-step, ensuring each transaction and its components are located before starting extraction.\n\nFor each transaction you identify, systematically extract and record the following fields:\n- Time \n- Amount \n- Currency \n- Purpose or transaction description \n\nMake sure that each field you extract is as complete and accurate as possible, directly based on the content in the OCR result. \n\nIf a particular field for any transaction is missing or cannot be confidently identified, use the placeholder value [unclear] for that field.\n\n# Steps\n\n1. Review the OCR output to determine the layout and structure of the transaction data.\n2. Identify where each transaction starts and ends.\n3. For each transaction, extract the requested fields (time, amount, currency, purpose), using [unclear] for any missing information.\n4. Ensure your extracted data covers all transaction records present in the OCR result and reflects the data faithfully.\n5. If the OCR is too blurry, corrupted, or unreadable, return an empty array as your output.\n\n# Output Format\n\nReturn your answer as a JSON array. Each transaction is a JSON object containing these fields:\n- \"time\": [date]\n- \"amount\": [number or string, as given]\n- \"currency\": [string]\n- \"purpose\": [string]\n\nDo not include any explanation, commentary, or extra information—output the JSON array only.\n\n# Examples\n\nInput:\nOCR result content (as extracted text from an image of a bank statement).\n\nExample Output:\n[\n  {\n    \"time\": \"2023-06-01\",\n    \"amount\": \"1000.00\",\n    \"currency\": \"CNY\",\n    \"purpose\": \"ATM Withdrawal\"\n  },\n  {\n    \"time\": \"2023-06-01\",\n    \"amount\": \"-25.00\",\n    \"currency\": \"CNY\",\n    \"purpose\": \"Coffee Shop\"\n  }\n]\n(For real tasks, populate fields with actual data extracted from the OCR result. Use [unclear] where fields cannot be determined.)\n\n# Notes\n\n- If you cannot reliably extract any transactions or the text is unreadable, output only: []\n- Apply a step-by-step approach: analyze and identify before extracting.\n- All required fields should be present in each transaction; use [unclear] if any are missing.\n- Format strictly as a JSON array, with no extra commentary.\n\n[Reminder: Your objective is to analyze the OCR result for all available transaction records, reason through the structure, and output them as clearly and completely as possible in the specified JSON format. If the task involves multiple reasoning steps (e.g., identifying then extracting), ensure you approach each step methodically before producing the final answer.]`;
  const parsed = await chatJSON(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    "openai/gpt-5-mini"
  );

  let transactions: any[] = [];
  if (Array.isArray(parsed?.transactions)) transactions = parsed.transactions;
  else if (Array.isArray(parsed)) transactions = parsed;
  else if (parsed && typeof parsed === "object") transactions = [parsed];

  for (const tx of transactions) {
    if (tx.currency && tx.amount) {
      const currentCurrency = String(tx.currency).toUpperCase();
      if (currentCurrency !== "EUR") {
        try {
          const rate = await getCurrencyConversionRate(currentCurrency, "EUR");
          tx.amount = convertCurrency(tx.amount, rate);
          tx.currency = "EUR";
        } catch (e) {
          tx.conversion_error = (e as Error).message;
        }
      }
    }
  }

  let notion: any = null;
  try {
    notion = await uploadTransactionsToNotion(transactions);
  } catch (e) {
    notion = { error: (e as Error).message };
  }
  return c.json({ transactions, notion });
});

// Plain utility to upload transaction objects to Notion (columns: Name, Price, Date)
interface TransactionRecord {
  time?: string;
  date?: string;
  amount?: number | string;
  currency?: string;
  purpose?: string;
  name?: string;
  [k: string]: any;
}

async function uploadTransactionsToNotion(
  transactions: TransactionRecord | TransactionRecord[]
) {
  const NOTION_TOKEN = process.env.notion_API_KEY || process.env.NOTION_API_KEY;
  const DATABASE_ID = process.env.Database_ID || process.env.DATABASE_ID;
  if (!NOTION_TOKEN)
    throw new Error("Missing env notion_API_KEY / NOTION_API_KEY");
  if (!DATABASE_ID) throw new Error("Missing env Database_ID / DATABASE_ID");
  const list = Array.isArray(transactions) ? transactions : [transactions];
  if (!list.length) return { message: "No transactions" };
  const results: { success: boolean; id?: string; error?: string }[] = [];
  for (const raw of list) {
    try {
      const name = String(raw.purpose || raw.name || "Unknown");
      let amountVal: number | null = null;
      if (raw.amount !== undefined) {
        try {
          amountVal = toNumber(raw.amount);
        } catch {
          amountVal = null;
        }
      }
      const dateStr = extractISODate(raw.time || raw.date);
      const payload: any = {
        parent: { database_id: DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name.slice(0, 2000) } }] },
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
        const err = await notionResponse.json().catch(() => ({}));
        throw new Error(err?.message || `HTTP ${notionResponse.status}`);
      }
      const page = await notionResponse.json();
      results.push({ success: true, id: page.id });
    } catch (e: any) {
      results.push({ success: false, error: e?.message || String(e) });
    }
  }
  return { uploaded: results };
}

function extractISODate(input: any): string | null {
  console.log("Extracting date from:", input);
  const today = new Date().toISOString().split("T")[0];
  if (!input) return today; // fallback to today when nothing provided
  try {
    if (typeof input === "string") {
      const iso = input.match(/(\d{4}-\d{2}-\d{2})/);
      if (iso) return iso[1];
      // Normalize common '22 August 2025 at 13:11' pattern
      const normalized = input.replace(/ at /i, " ");
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    }
    if (input instanceof Date) return input.toISOString().split("T")[0];
  } catch (e) {
    console.warn("Date parse exception:", (e as Error).message);
  }
  console.log("Failed to parse date, using today:", today);
  return today;
}

async function getCurrencyConversionRate(
  from: string,
  to: string
): Promise<number> {
  const base = from?.toUpperCase();
  const target = to?.toUpperCase();
  if (!base || !target)
    throw new Error("Both from and to currencies are required");
  if (base === target) return 1;
  const apiKey = process.env.currency_API_KEY || process.env.CURRENCY_API_KEY;
  if (!apiKey) throw new Error("currency_API_KEY env var not set");
  const url = `https://api.currencyapi.com/v3/latest?apikey=${apiKey}&currencies=${encodeURIComponent(
    target
  )}&base_currency=${encodeURIComponent(base)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Currency API error ${res.status}: ${txt}`);
  }
  const data: any = await res.json();
  const value = data?.data?.[target]?.value;
  if (typeof value !== "number")
    throw new Error("Unexpected currency API response structure");
  return value;
}

function convertCurrency(amount: string | number, rate: number): number {
  if (rate === 1) return toNumber(amount);
  const numeric = toNumber(amount);
  return Math.round((numeric * rate + Number.EPSILON) * 100) / 100;
}

function toNumber(a: string | number): number {
  if (typeof a === "number") return a;
  const cleaned = a.replace(/[^0-9+\-.,]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Invalid amount: ${a}`);
  return n;
}

function safeParseJSON(text: any): any {
  if (text == null) return {};
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/([\[{].*[\]}])/s);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {}
  }
  return {};
}

export default app;
