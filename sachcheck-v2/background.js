// background.js — SachCheck v2
// Uses Gemini 2.0 Flash with Google Search grounding

// API base endpoint. URL is dynamically generated based on active model fallback.

// Open side panel when clicking the extension icon
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.log("Error setting side panel behavior:", error));
}

// Track when side panel is closed to auto-close in-page overlays
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    port.onDisconnect.addListener(() => {
      console.log("[SachCheck] Side panel closed. Cleaning up overlays...");
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: "STOP" }, () => {
            // Ignore error if tab is closed or content script is not loaded
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
    chrome.storage.local.set({ groqKey: message.apiKey }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  if (message.type === "GET_API_KEY") {
    chrome.storage.local.get("groqKey", data =>
      sendResponse({ apiKey: data.groqKey || "" })
    );
    return true;
  }

  if (message.type === "SAVE_VOICE_PREF") {
    chrome.storage.local.set({ voiceEnabled: message.enabled }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  if (message.type === "GET_VOICE_PREF") {
    chrome.storage.local.get("voiceEnabled", data =>
      sendResponse({ enabled: data.voiceEnabled !== false }) // default ON
    );
    return true;
  }
});

// ── DuckDuckGo HTML Web Search ───────────────────────────────────────────────
async function searchWeb(query) {
  // 1. Try DuckDuckGo HTML Search
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) throw new Error(`DuckDuckGo HTML search failed: status ${response.status}`);
    const html = await response.text();
    
    const snippets = [];
    const regex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && snippets.length < 5) {
      const cleanText = match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (cleanText) snippets.push(cleanText);
    }
    
    if (snippets.length > 0) {
      return snippets.join("\n\n");
    }
    
    console.warn("[SachCheck] DuckDuckGo HTML search returned empty results (likely CAPTCHA/bot blocked). Trying JSON Instant-Answer API fallback...");
  } catch (err) {
    console.warn("[SachCheck] DuckDuckGo HTML search error, trying JSON Instant-Answer API fallback:", err.message);
  }

  // 2. Try DuckDuckGo JSON Instant Answer API as a key-free fallback
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DuckDuckGo JSON API failed: status ${response.status}`);
    const data = await response.json();
    
    const snippets = [];
    if (data.AbstractText) {
      snippets.push(data.AbstractText);
    }
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics) {
        if (item.Topics && Array.isArray(item.Topics)) {
          for (const subItem of item.Topics) {
            if (subItem.Text && snippets.length < 5) {
              snippets.push(subItem.Text);
            }
          }
        } else if (item.Text && snippets.length < 5) {
          snippets.push(item.Text);
        }
      }
    }
    
    if (snippets.length > 0) {
      console.log("[SachCheck] Web search fetched results from DuckDuckGo JSON Instant-Answer API.");
      return snippets.join("\n\n");
    }
  } catch (err) {
    console.error("[SachCheck] DuckDuckGo JSON API fallback error:", err.message);
  }

  console.warn("[SachCheck] Web search completely failed or returned no results. Proceeding with empty web context.");
  return "";
}

// ── Groq Fact-Check ──────────────────────────────────────────────────────────
async function handleFactCheck(claim, apiKey) {
  // 1. Perform Web Search first
  const searchResults = await searchWeb(claim);
  console.log("[SachCheck] DuckDuckGo search result snippet count:", searchResults ? searchResults.split("\n\n").length : 0);
  
  if (!searchResults) {
    console.warn(`[SachCheck] WARNING: Fact-checking claim "${claim}" with empty search context due to search block or lack of search results.`);
  }

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
- If search snippets contradict the claim, immediately set verdict to "FALSE". Do not be hesitant to mark wrong information as "FALSE".
- Only fact-check verifiable factual claims, not opinions.
- If search snippets do not have enough information to confirm or deny, use "UNVERIFIED".
- Language Rule: If the input claim is in Hindi or Hinglish, write the "summary", "evidence", and "speak" fields in Hindi (using Devanagari script). Otherwise, write them in English.
- The "verdict" field MUST always be in English ("TRUE", "MISLEADING", "FALSE", or "UNVERIFIED") for system parsing.
- The "speak" field must be a natural spoken sentence.
  Example of TRUE in English: "This claim is TRUE. India's GDP growth is confirmed at 8.2 percent."
  Example of FALSE in English: "This claim is FALSE. The government has not announced any such tax cut."
  Example of TRUE in Hindi: "यह दावा सच है। भारत की जीडीपी ग्रोथ 8.2 प्रतिशत दर्ज की गई है।"
  Example of FALSE in Hindi: "यह दावा गलत है। सरकार ने ऐसे किसी टैक्स कटौती की घोषणा नहीं की है।"`;

  const userContent = `Claim: "${claim}"

Web Search Snippets:
${searchResults || "No search results found."}`;

  // Priority list of models to try on Groq
  const modelsToTry = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama3-70b-8192",
    "mixtral-8x7b-32768"
  ];

  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[SachCheck] Trying Groq model ${modelName}...`);
      const result = await fetchFromGroqAPI(modelName, systemInstructions, userContent, apiKey);
      console.log(`[SachCheck] Successful fact-check with Groq model ${modelName}`);
      return result;
    } catch (err) {
      console.log(`[SachCheck] Groq model ${modelName} failed:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All Groq models failed. Last error: ${lastError?.message || "Unknown error"}`);
}

async function fetchFromGroqAPI(modelName, systemInstructions, userContent, apiKey) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const res = await fetch(url, {
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
    throw new Error(`Groq API returned status ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from Groq model");
  }

  try {
    return JSON.parse(content.trim());
  } catch (err) {
    throw new Error(`Failed to parse Groq response as JSON: ${content}`);
  }
}
