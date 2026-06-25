// background.js — SachCheck v2.1 (fixed)

// ── Side Panel Behavior ───────────────────────────────────────────────────────
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.log("Error setting side panel behavior:", err));
}

// ── Service Worker Keep-Alive ─────────────────────────────────────────────────
// MV3 service workers die after ~30s idle. We keep it alive via a recurring alarm.
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // No-op ping just to keep the SW alive
  }
});

// ── Side Panel Close → Stop overlays ─────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    port.onDisconnect.addListener(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: "STOP" }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
  }
});

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "FACT_CHECK") {
    handleFactCheck(message.claim, message.apiKey)
      .then(result => sendResponse({ success: true, result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_API_KEY") {
    // Use storage.sync so key persists across profile resets
    chrome.storage.sync.set({ groqKey: message.apiKey }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  if (message.type === "GET_API_KEY") {
    chrome.storage.sync.get("groqKey", data =>
      sendResponse({ apiKey: data.groqKey || "" })
    );
    return true;
  }

  if (message.type === "SAVE_VOICE_PREF") {
    chrome.storage.sync.set({ voiceEnabled: message.enabled }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  if (message.type === "GET_VOICE_PREF") {
    chrome.storage.sync.get("voiceEnabled", data =>
      sendResponse({ enabled: data.voiceEnabled !== false })
    );
    return true;
  }
});

// ── DuckDuckGo Instant Answer API (replaces broken HTML scrape) ───────────────
async function searchWeb(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error(`DDG API status: ${response.status}`);
    const data = await response.json();

    const parts = [];

    // Abstract text (best summary)
    if (data.AbstractText) parts.push(data.AbstractText);

    // Related topics snippets
    if (Array.isArray(data.RelatedTopics)) {
      for (const t of data.RelatedTopics.slice(0, 4)) {
        if (t.Text) parts.push(t.Text);
        // Nested Topics
        if (Array.isArray(t.Topics)) {
          for (const sub of t.Topics.slice(0, 2)) {
            if (sub.Text) parts.push(sub.Text);
          }
        }
      }
    }

    // Answer field
    if (data.Answer) parts.push(data.Answer);

    const result = parts.filter(Boolean).join("\n\n").trim();
    console.log("[SachCheck] DDG result length:", result.length);
    return result;
  } catch (err) {
    console.log("[SachCheck] Web search error:", err.message);
    return "";
  }
}

// ── Groq Fact-Check ───────────────────────────────────────────────────────────
async function handleFactCheck(claim, apiKey) {
  const searchResults = await searchWeb(claim);
  console.log("[SachCheck] Search snippets:", searchResults ? searchResults.slice(0, 100) : "(none)");

  const systemInstructions = `You are SachCheck, an unbiased, highly accurate, and decisive real-time fact-checker for Indian news broadcasts.
You will be given a claim and search snippets from the web.
Analyze the search snippets and fact-check the claim.

Return ONLY a raw JSON object. Do not wrap in markdown or code blocks. Exactly this structure:
{
  "verdict": "TRUE" or "MISLEADING" or "FALSE" or "UNVERIFIED",
  "confidence": <integer 0-100>,
  "summary": "<one sentence, max 20 words>",
  "evidence": "<what search found, max 30 words>",
  "source": "<source name or URL>",
  "speak": "<short 1-sentence verdict to speak aloud, max 15 words>"
}

Rules:
- If search snippets contradict the claim, set verdict to "FALSE".
- Only fact-check verifiable factual claims, not opinions.
- If search snippets do not have enough information, use "UNVERIFIED".
- Language Rule: If the input claim is in Hindi or Hinglish, write the "summary", "evidence", and "speak" fields in Hindi (Devanagari script). Otherwise write in English.
- The "verdict" field MUST always be in English for system parsing.
- The "speak" field must be a natural spoken sentence.`;

  const userContent = `Claim: "${claim}"\n\nWeb Search Snippets:\n${searchResults || "No search results found."}`;

  const modelsToTry = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama3-70b-8192",
    "mixtral-8x7b-32768"
  ];

  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const result = await fetchFromGroqAPI(modelName, systemInstructions, userContent, apiKey);
      console.log(`[SachCheck] Success with model ${modelName}`);
      return result;
    } catch (err) {
      console.log(`[SachCheck] Model ${modelName} failed:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All Groq models failed. Last error: ${lastError?.message}`);
}

async function fetchFromGroqAPI(modelName, systemInstructions, userContent, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemInstructions },
        { role: "user", content: userContent }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 256
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from Groq");

  try {
    return JSON.parse(content.trim());
  } catch {
    throw new Error(`JSON parse failed: ${content}`);
  }
}
