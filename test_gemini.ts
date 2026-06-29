import dotenv from "dotenv";
dotenv.config({ override: true });
import { getModel, callGemini } from "./src/server/aiService.ts";

async function main() {
  const key = process.env.GEMINI_API_KEY;
  console.log("Analyzing GEMINI_API_KEY in test environment:");
  if (!key) {
    console.log("-> GEMINI_API_KEY is not defined in process.env");
  } else {
    console.log("-> Length:", key.length);
    console.log("-> Starts with:", JSON.stringify(key.substring(0, 8)));
    console.log("-> Ends with:", JSON.stringify(key.substring(key.length - 8)));
    console.log("-> Contains spaces/newlines:", /\s/.test(key));
    if (key.startsWith('"') && key.endsWith('"')) {
      console.log("-> Key is wrapped in double quotes!");
    }
    if (key.startsWith("'") && key.endsWith("'")) {
      console.log("-> Key is wrapped in single quotes!");
    }
  }

  console.log("Calling callGemini with different models to see which one succeeds...");
  const modelsToTest = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  for (const model of modelsToTest) {
    try {
      console.log(`\nTesting model: ${model}...`);
      const res = await callGemini(model, "Say 'The Safarnama Connection is Live for " + model + "!'", false);
      console.log(`SUCCESS with ${model}! Gemini responded with:`, res);
      break; // stop on first successful model
    } catch (err: any) {
      console.error(`FAILED with ${model}:`);
      console.error(err.message || err);
    }
  }
}

main();
