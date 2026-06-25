// popup.js — SachCheck v2

// Connect to background script to signal that the side panel is active/open
chrome.runtime.connect({ name: "sidepanel" });
const mainBtn     = document.getElementById("main-btn");
const apiKeyInput = document.getElementById("api-key");
const saveBtn     = document.getElementById("save-btn");
const savedMsg    = document.getElementById("saved-msg");
const voiceToggle = document.getElementById("voice-toggle");
const channelRow  = document.getElementById("channel-row");
const dotEl       = document.getElementById("dot");
const channelText = document.getElementById("channel-text");

let isRunning = false;
let voiceOn   = true;

const INDIAN_CHANNELS = [
  { name: "Republic TV",   keys: ["republic"] },
  { name: "Zee News",      keys: ["zee news", "zeenews"] },
  { name: "NDTV",          keys: ["ndtv"] },
  { name: "Times Now",     keys: ["times now", "timesnow"] },
  { name: "Aaj Tak",       keys: ["aaj tak"] },
  { name: "India Today",   keys: ["india today"] },
  { name: "News18",        keys: ["news18"] },
  { name: "WION",          keys: ["wion"] },
  { name: "ABP News",      keys: ["abp news", "abplive"] },
  { name: "DD News",       keys: ["dd news", "doordarshan"] },
  { name: "TV9 Bharatvarsh", keys: ["tv9 bharat"] },
  { name: "Mirror Now",    keys: ["mirror now"] },
];

// ── Init ──────────────────────────────────────────────────────────────────────

// Load saved key
chrome.storage.local.get("groqKey", data => {
  if (data.groqKey) apiKeyInput.value = data.groqKey;
});

// Load voice pref
chrome.storage.local.get("voiceEnabled", data => {
  voiceOn = data.voiceEnabled !== false;
  voiceToggle.className = "toggle" + (voiceOn ? " on" : "");
});

// Detect and update active tab status
function updateActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;

    // Reset status UI to default
    channelRow.classList.remove("detected");
    dotEl.classList.remove("active");

    if (!tab.url?.includes("youtube.com")) {
      channelText.textContent = "Open a YouTube Live stream to begin";
      setStartUI();
      isRunning = false;
      return;
    }

    const title = (tab.title || "").toLowerCase();
    const found = INDIAN_CHANNELS.find(ch => ch.keys.some(k => title.includes(k)));

    if (found) {
      channelRow.classList.add("detected");
      dotEl.classList.add("active");
      channelText.textContent = found.name + " detected ✓";
    } else {
      channelText.textContent = "YouTube open — find an Indian news Live stream";
    }

    // Check running state on the content script
    try {
      chrome.tabs.sendMessage(tab.id, { type: "STATUS" }, res => {
        if (chrome.runtime.lastError) {
          if (tab.url?.includes("youtube.com")) {
            channelText.textContent = "⚠️ Please refresh the YouTube tab to initialize";
          }
          setStartUI();
          isRunning = false;
          return;
        }
        if (res?.running) {
          isRunning = true;
          setStopUI();
        } else {
          isRunning = false;
          setStartUI();
        }
      });
    } catch (e) {
      console.log("[SachCheck] Could not request status from tab:", e);
      setStartUI();
      isRunning = false;
    }
  });
}

// Run on initial load
updateActiveTab();

// Listen for tab switching and URL updates
chrome.tabs.onActivated.addListener(updateActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab && tab.active) {
    updateActiveTab();
  }
});

// ── Events ────────────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, () => {
    if (chrome.runtime.lastError) {}
    savedMsg.textContent = "✓ Key saved";
    setTimeout(() => savedMsg.textContent = "", 2000);
  });
});

voiceToggle.addEventListener("click", () => {
  voiceOn = !voiceOn;
  voiceToggle.className = "toggle" + (voiceOn ? " on" : "");
  chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceOn }, () => {
    if (chrome.runtime.lastError) {}
  });
});

mainBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    apiKeyInput.style.borderColor = "#ef4444";
    apiKeyInput.placeholder = "Groq API key required!";
    setTimeout(() => {
      apiKeyInput.style.borderColor = "";
      apiKeyInput.placeholder = "gsk_...";
    }, 2500);
    return;
  }

  // Save key
  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, () => {
    if (chrome.runtime.lastError) {}
  });
  chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceOn }, () => {
    if (chrome.runtime.lastError) {}
  });

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;
    const type = isRunning ? "STOP" : "START";
    chrome.tabs.sendMessage(tab.id, { type }, () => {
      if (chrome.runtime.lastError) {
        console.log("[SachCheck] sendMessage failed:", chrome.runtime.lastError.message);
        return;
      }
      isRunning = !isRunning;
      isRunning ? setStopUI() : setStartUI();
    });
  });
});

function setStopUI() {
  mainBtn.textContent = "⏹ Stop Fact-Checking";
  mainBtn.className   = "main-btn btn-stop";
}

function setStartUI() {
  mainBtn.textContent = "▶ Start Fact-Checking";
  mainBtn.className   = "main-btn btn-start";
}
