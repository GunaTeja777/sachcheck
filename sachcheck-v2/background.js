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
    chrome.storage.local.set({ geminiKey: message.apiKey }, () =>
      sendResponse({ success: true })
    );
    return true;
  }

  if (message.type === "GET_API_KEY") {
    chrome.storage.local.get("geminiKey", data =>
      sendResponse({ apiKey: data.geminiKey || "" })
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

// ── Gemini Fact-Check ─────────────────────────────────────────────────────────

const PREFERENCE_ORDER = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-2.0-flash-lite-preview-02-05",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash-8b-latest"
];

async function getAvailableModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) throw new Error(`ListModels failed with status ${res.status}`);
    const data = await res.json();
    
    if (!data.models || !Array.isArray(data.models)) {
      throw new Error("Invalid models list response format");
    }

    // Filter models that support generateContent
    const validModels = data.models
      .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
      .map(m => m.name.replace("models/", "")); // Strip 'models/' prefix

    console.log("[SachCheck] Available models from API:", validModels);
    return validModels;
  } catch (err) {
    console.log("[SachCheck] Error fetching model list:", err);
    // Return sensible fallback defaults if the API list endpoint fails
    return [
      "gemini-2.0-flash",
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash",
      "gemini-2.0-flash-lite-preview-02-05",
      "gemini-1.5-pro"
    ];
  }
}

function sortModels(availableModels) {
  return [...availableModels].sort((a, b) => {
    let indexA = PREFERENCE_ORDER.indexOf(a);
    let indexB = PREFERENCE_ORDER.indexOf(b);
    if (indexA === -1) indexA = 999;
    if (indexB === -1) indexB = 999;
    return indexA - indexB;
  });
}

async function handleFactCheck(claim, apiKey) {
  const prompt = `You are SachCheck, an unbiased, highly accurate, and decisive real-time fact-checker for Indian news broadcasts.

Fact-check this claim using Google Search: "${claim}"

Return ONLY a raw JSON object — no markdown, no code fences, no explanation. Exactly this structure:
{
  "verdict": "TRUE" or "MISLEADING" or "FALSE" or "UNVERIFIED",
  "confidence": <integer 0-100>,
  "summary": "<one sentence, max 20 words>",
  "evidence": "<what search found, max 30 words>",
  "source": "<source name or URL>",
  "speak": "<short 1-sentence verdict to speak aloud, max 15 words>"
}

Rules:
- Search Google thoroughly to find official reports, reputable news outlets, or Indian fact-checking websites (e.g., PIB Fact Check, Alt News, Boom Live).
- If a claim is contradicted by facts, official data, or credible sources, immediately label the verdict as "FALSE". Do not be hesitant to mark wrong information as "FALSE".
- Only fact-check verifiable factual claims, not opinions.
- If unverifiable, use "UNVERIFIED".
- Language Rule: If the input claim is in Hindi or Hinglish (transliterated Hindi), write the "summary", "evidence", and "speak" fields in Hindi (using Devanagari script). Otherwise, write them in English.
- The "verdict" field MUST always be in English ("TRUE", "MISLEADING", "FALSE", or "UNVERIFIED") for system parsing.
- The "speak" field must be a natural spoken sentence.
  Example of TRUE in English: "This claim is TRUE. India's GDP growth is confirmed at 8.2 percent."
  Example of FALSE in English: "This claim is FALSE. The government has not announced any such tax cut."
  Example of TRUE in Hindi: "यह दावा सच है। भारत की जीडीपी ग्रोथ 8.2 प्रतिशत दर्ज की गई है।"
  Example of FALSE in Hindi: "यह दावा गलत है। सरकार ने ऐसे किसी टैक्स कटौती की घोषणा नहीं की है।"`;

  const bodyWithSearch = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512
    }
  };

  const bodyWithoutSearch = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512
    }
  };

  // Get active models from user's key
  const available = await getAvailableModels(apiKey);
  const sorted = sortModels(available);

  // Construct target config queue
  const configsToTry = [];
  
  // Try all sorted models WITH search first
  for (const modelName of sorted) {
    configsToTry.push({ name: modelName, useSearch: true });
  }
  // Try all sorted models WITHOUT search as a final fallback (e.g. if grounding limits or issues occur)
  for (const modelName of sorted) {
    configsToTry.push({ name: modelName, useSearch: false });
  }

  let lastError = null;

  for (const config of configsToTry) {
    try {
      console.log(`[SachCheck] Trying model ${config.name} (Search: ${config.useSearch})...`);
      const body = config.useSearch ? bodyWithSearch : bodyWithoutSearch;
      const result = await fetchFromGeminiAPI(config.name, body, apiKey);
      console.log(`[SachCheck] Successful fact-check with model ${config.name}`);
      return result;
    } catch (err) {
      console.log(`[SachCheck] Model ${config.name} (Search: ${config.useSearch}) failed:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError?.message || "Unknown error"}`);
}

async function fetchFromGeminiAPI(modelName, body, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data.error?.message || `API error ${res.status}`;
    throw new Error(msg);
  }

  const raw = data.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "")
    .join("")
    .trim() || "";

  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    return {
      verdict: "UNVERIFIED",
      confidence: 0,
      summary: "Could not parse Gemini response.",
      evidence: raw.slice(0, 100),
      source: "Gemini AI",
      speak: "Verdict is unverified. Could not parse the response."
    };
  }
}
