// background.js — SachCheck v2.2

// ── Side Panel: open on icon click ───────────────────────────────────────────
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(e => console.log("sidePanel error:", e));
}

// ── Keep service worker alive (MV3 dies after 30s idle) ───────────────────────
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// ── Side panel disconnect → stop content script overlay ──────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    port.onDisconnect.addListener(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "STOP" }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
  }
});

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "FACT_CHECK") {
    handleFactCheck(msg.claim, msg.apiKey)
      .then(r  => sendResponse({ success: true, result: r }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === "SAVE_API_KEY") {
    chrome.storage.sync.set({ groqKey: msg.apiKey }, () => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === "GET_API_KEY") {
    chrome.storage.sync.get("groqKey", d => sendResponse({ apiKey: d.groqKey || "" }));
    return true;
  }
  if (msg.type === "SAVE_VOICE_PREF") {
    chrome.storage.sync.set({ voiceEnabled: msg.enabled }, () => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === "GET_VOICE_PREF") {
    chrome.storage.sync.get("voiceEnabled", d => sendResponse({ enabled: d.voiceEnabled !== false }));
    return true;
  }

  // ── FIX: Inject content script dynamically if not yet present ──────────────
  // YouTube SPA navigations don't re-inject content scripts automatically.
  // The popup calls INJECT_IF_NEEDED before START so it always works.
  if (msg.type === "INJECT_IF_NEEDED") {
    const tabId = msg.tabId;
    // Ping the tab — if it responds, already injected
    chrome.tabs.sendMessage(tabId, { type: "STATUS" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        // Not injected — inject now
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => {
            chrome.scripting.insertCSS(
              { target: { tabId }, files: ["styles.css"] },
              () => sendResponse({ injected: true })
            );
          }
        );
      } else {
        sendResponse({ injected: false }); // already there
      }
    });
    return true;
  }
});

// ── Groq Fact-Check (no DDG — DDG instant API returns nothing for news) ───────
// Instead we rely on Groq's knowledge + ask it to reason from what it knows.
// For real web grounding, users should use Groq's llama with tool_use,
// but for simplicity we send the claim directly with a strong system prompt.
async function handleFactCheck(claim, apiKey) {
  const systemPrompt = `You are SachCheck, an unbiased real-time fact-checker for Indian news broadcasts.

Fact-check the given claim using your knowledge of Indian politics, economy, and current affairs.

Return ONLY a raw JSON object (no markdown, no code blocks):
{
  "verdict": "TRUE" or "MISLEADING" or "FALSE" or "UNVERIFIED",
  "confidence": <integer 0-100>,
  "summary": "<one sentence, max 20 words>",
  "evidence": "<what you know about this, max 30 words>",
  "source": "<known source or 'General Knowledge'>",
  "speak": "<short spoken verdict, max 15 words>"
}

Rules:
- TRUE = claim matches known facts with high confidence
- MISLEADING = partially true but missing key context or exaggerated
- FALSE = contradicts known facts
- UNVERIFIED = you cannot confidently verify or deny it
- If claim is in Hindi/Hinglish, respond with summary/evidence/speak in Hindi (Devanagari)
- The "verdict" field must always be in English`;

  const modelsToTry = [
    "llama-3.1-70b-versatile",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768"
  ];

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: `Claim: "${claim}"` }
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 300
        })
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Groq ${res.status}: ${txt.slice(0, 100)}`);
      }

      const data    = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty Groq response");
      return JSON.parse(content.trim());
    } catch (e) {
      console.log(`[SachCheck] ${model} failed:`, e.message);
      lastError = e;
    }
  }
  throw new Error("All models failed: " + lastError?.message);
}
