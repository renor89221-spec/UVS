/**
 * ============================================================================
 * MODULE: modelRouter.js
 * PURPOSE: Handles AI model routing and execution.
 *          Implements 3-Stage Batch Fallback for OCR & Vision processing:
 *            Stage 1: First 4 Gemini keys (sent in parallel, first to succeed wins)
 *            Stage 2: Next 5 Gemini keys (sent in parallel, first to succeed wins)
 *            Stage 3: OpenRouter API (Minimax vision model)
 *          Also provides text-based reasoning via Groq with round-robin key rotation.
 * ============================================================================
 */

const axios = require("axios");
const Groq  = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

// ─── GROQ KEYS ROTATION (Reasoning) ───
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_ONE,
  process.env.GROQ_API_KEY_TWO,
  process.env.GROQ_API_KEY_THREE,
  process.env.GROQ_API_KEY_FOUR,
  process.env.GROQ_API_KEY_FIVE,
  process.env.GROQ_API_KEY_SIX,
  process.env.GROQ_API_KEY_SEVEN,
  process.env.GROQ_API_KEY_EIGHT,
].filter(Boolean);

let groqKeyIndex = 0;
function getNextApiKey() {
  if (GROQ_KEYS.length === 0) return null;
  const key = GROQ_KEYS[groqKeyIndex % GROQ_KEYS.length];
  groqKeyIndex++;
  return key;
}

// ─── GEMINI KEYS & OPENROUTER ───
const GEMINI_KEYS = [
  process.env.SOUMYA_GEMINI_ONE,
  process.env.SOUMYA_GEMINI_TWO,
  process.env.SOUMYA_GEMINI_THREE,
  process.env.GEMINI_API_KEY_ONE,
  process.env.GEMINI_API_KEY_TWO,
  process.env.GEMINI_API_KEY_THREE,
  process.env.GEMINI_API_KEY_FOUR,
  process.env.GEMINI_API_KEY_FIVE,
  process.env.GEMINI_API_KEY_SIX,
  process.env.GEMINI_API_KEY_SEVEN,
  process.env.GEMINI_API_KEY_EIGHT,
  process.env.GEMINI_API_KEY_NINE || process.env.GEMINI_API_NINE,
].filter(Boolean);

let geminiKeyIndex = 0;
function getNextGeminiApiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
  geminiKeyIndex++;
  return key;
}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "minimax/minimax-m3.1-flash:free";
const OPENROUTER_ENDPOINT = process.env.OPENROUTER_ENDPOINT || "https://openrouter.ai/api/v1/chat/completions";

function parseMaybeJson(content) {
  if (!content || typeof content !== "string") {
    throw new Error("Cannot parse empty content as JSON");
  }

  // Strip reasoning block if present
  let cleaned = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();

  // Strip markdown code fences if present
  cleaned = cleaned.replace(/```json\s*([\s\S]*?)\s*```/g, "$1").trim();
  cleaned = cleaned.replace(/```\s*([\s\S]*?)\s*```/g, "$1").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerErr) {
        throw new Error("Extracted text is not valid JSON: " + match[0]);
      }
    }
    throw new Error(`Failed to parse JSON. Content was: ${content.slice(0, 200)}... Error: ${e.message}`);
  }
}

/**
 * Builds the inline contents array for Gemini SDK.
 * @param {Array<{base64: string, mimeType: string}>} images
 * @param {string} prompt
 */
function buildGeminiContents(images, prompt) {
  const contents = [];
  for (const img of images) {
    contents.push({
      inlineData: {
        data: img.base64,
        mimeType: img.mimeType || "image/jpeg"
      }
    });
  }
  contents.push(prompt);
  return contents;
}

/**
 * Executes a single request to Gemini via the @google/genai SDK.
 */
async function sendToGeminiKey(apiKey, prompt, images) {
  const ai = new GoogleGenAI({ apiKey });
  const contents = buildGeminiContents(images, prompt);

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents,
    config: {
      responseMimeType: "application/json"
    }
  });

  return parseMaybeJson(response.text);
}

/**
 * Executes a vision prompt using round-robin rotation of Gemini keys one by one,
 * followed by OpenRouter fallback if all Gemini keys fail.
 *
 * @param {string} prompt
 * @param {Array<{base64: string, mimeType: string}>} images
 */
async function executeVisionPipeline(prompt, images) {
  let lastError = null;
  const attemptsCount = GEMINI_KEYS.length;

  for (let attempt = 0; attempt < attemptsCount; attempt++) {
    const key = getNextGeminiApiKey();
    if (!key) break;

    try {
      console.log(`[ModelRouter] Attempting Gemini key ...${key.slice(-6)} (attempt ${attempt + 1}/${attemptsCount})...`);
      const res = await sendToGeminiKey(key, prompt, images);
      console.log(`[ModelRouter] Key ending in ...${key.slice(-6)} succeeded!`);
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`[ModelRouter] Key ending in ...${key.slice(-6)} failed: ${err.message}`);
      if (attempt < attemptsCount - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  // ── OpenRouter Fallback ───────────────────────────────────────────────────
  if (OPENROUTER_KEY) {
    try {
      console.log("[ModelRouter] Attempting OpenRouter fallback...");
      const result = await sendToOpenRouter(prompt, images);
      return result;
    } catch (err) {
      lastError = err;
      console.error("[ModelRouter] OpenRouter failed:", err.message);
    }
  } else {
    console.warn("[ModelRouter] OpenRouter skipped: OPENROUTER_API_KEY not configured.");
  }

  console.error("❌ All vision attempts failed. Last error:", lastError?.message);
  return null;
}

/**
 * Single-image vision fallback helper (backward compatible).
 */
async function extractWithFallback(prompt, base64Image, imageUrl = null, mimeType = "image/jpeg") {
  return executeVisionPipeline(prompt, [{ base64: base64Image, mimeType }]);
}

// Text-only reasoning — groq-sdk is fine here (no large payloads)
async function analyzeRunsWithReasoning(prompt) {
  try {
    const apiKey = getNextApiKey() || process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("❌ Reasoning analysis failed: Missing GROQ_API_KEY in .env");
      return null;
    }

    const currentGroq = new Groq({ apiKey });

    const res = await currentGroq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0.2,
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("Reasoning analysis failed:", err.message);
    return null;
  }
}

module.exports = {
  extractWithFallback,
  executeVisionPipeline,
  analyzeRunsWithReasoning,
  GEMINI_KEYS,
  OPENROUTER_KEY
};
