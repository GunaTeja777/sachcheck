// popup.js — SachCheck v2.1 (fixed)

// Connect to background to signal side panel is open
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
  { name: "Republic TV",       keys: ["republic"] },
  { name: "Zee News",          keys: ["zee news", "zeenews"] },
  { name: "NDTV",              keys: ["ndtv"] },
  { name: "Times Now",         keys: ["times now", "timesnow"] },
  { name: "Aaj Tak",           keys: ["aaj tak"] },
  { name: "India Today",       keys: ["india today"] },
  { name: "News18",            keys: ["news18"] },
  { name: "WION",              keys: ["wion"] },
  { name: "ABP News",          keys: ["abp news", "abplive"] },
  { name: "DD News",           keys: ["dd news", "doordarshan"] },
  { name: "TV9 Bharatvarsh",   keys: ["tv9 bharat"] },
  { name: "Mirror Now",        keys: ["mirror now"] },
];

// ── Init ──────────────────────────────────────────────────────────────────────

// FIX: use storage.sync (matches background.js fix)
chrome.storage.sync.get("groqKey", data => {
  if (data.groqKey) apiKeyInput.value = data.groqKey;
});

chrome.storage.sync.get("voiceEnabled", data => {
  voiceOn = data.voiceEnabled !== false;
  voiceToggle.className = "toggle" + (voiceOn ? " on" : "");
});

// FIX: tab event listeners (onActivated / onUpdated) do NOT work in side panel
// pages. Replace with a polling interval.
function updateActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;

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

    chrome.tabs.sendMessage(tab.id, { type: "STATUS" }, res => {
      if (chrome.runtime.lastError) {
        // Content script not injected yet — YouTube tab needs a refresh
        if (!tab.url?.includes("youtube.com/watch")) {
          channelText.textContent = "Open a YouTube Live stream to begin";
        } else {
          channelText.textContent = "⚠️ Refresh the YouTube tab to initialize";
        }
        setStartUI();
        isRunning = false;
        return;
      }
      isRunning = res?.running === true;
      isRunning ? setStopUI() : setStartUI();
    });
  });
}

// Run on load
updateActiveTab();

// FIX: Poll every 2s instead of broken tab event listeners
setInterval(updateActiveTab, 2000);

// ── Events ────────────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  chrome.storage.sync.set({ groqKey: key }, () => {
    if (chrome.runtime.lastError) {}
    savedMsg.textContent = "✓ Key saved";
    setTimeout(() => (savedMsg.textContent = ""), 2000);
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

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;

    // FIX: validate we're on YouTube before sending
    if (!tab.url?.includes("youtube.com")) {
      channelText.textContent = "⚠️ Please open YouTube first!";
      return;
    }

    // Save prefs
    chrome.storage.sync.set({ groqKey: key });
    chrome.runtime.sendMessage({ type: "SAVE_VOICE_PREF", enabled: voiceOn });

    const type = isRunning ? "STOP" : "START";
    chrome.tabs.sendMessage(tab.id, { type }, res => {
      if (chrome.runtime.lastError) {
        channelText.textContent = "⚠️ Refresh YouTube tab and try again";
        console.log("[SachCheck] sendMessage failed:", chrome.runtime.lastError.message);
        return;
      }
      // FIX: only flip state after confirmed response
      if (res?.success) {
        isRunning = !isRunning;
        isRunning ? setStopUI() : setStartUI();
      }
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
