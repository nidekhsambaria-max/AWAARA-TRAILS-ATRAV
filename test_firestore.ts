import dotenv from "dotenv";
dotenv.config();
import { db, profilesCollection, tripsCollection } from "./src/server/db.ts";

async function main() {
  try {
    console.log("Attempting to read profilesCollection...");
    const snap = await profilesCollection.limit(1).get();
    console.log("Read success! Document count:", snap.size);
    
    console.log("Attempting to write a test document...");
    const docRef = await tripsCollection.add({
      test: true,
      createdAt: new Date(),
    });
    console.log("Write success! Document ID:", docRef.id);
    
    console.log("Deleting test document...");
    await docRef.delete();
    console.log("Delete success!");
  } catch (err: any) {
    console.error("Firestore Admin SDK Error:");
    console.error(err.message || err);
    console.error(JSON.stringify(err));
  }
}

main();
