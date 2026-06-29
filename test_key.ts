import dotenv from "dotenv";
dotenv.config();

function inspectKey() {
  const key = process.env.FIREBASE_PRIVATE_KEY;
  if (!key) {
    console.log("No FIREBASE_PRIVATE_KEY in env");
    return;
  }
  console.log("Key length:", key.length);
  console.log("Starts with:", JSON.stringify(key.slice(0, 40)));
  console.log("Ends with:", JSON.stringify(key.slice(-40)));
  
  // Test parsing
  let cleaned = key.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) cleaned = cleaned.slice(1, -1);
  if (cleaned.startsWith("'") && cleaned.endsWith("'")) cleaned = cleaned.slice(1, -1);
  
  console.log("Contains literal \\n:", cleaned.includes("\\n"));
  console.log("Contains real newlines:", cleaned.includes("\n"));
  
  const processed = cleaned.replace(/\\n/g, "\n");
  console.log("Processed Starts with:", JSON.stringify(processed.slice(0, 40)));
}

inspectKey();
