import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";

console.log("Gemini Key Loaded:", process.env.GEMINI_API_KEY?.slice(0, 6));

import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { generateItineraryBackend, generateGeneralAITool, getAI, exploreDestinationsBackend, getDestinationDetailsBackend, getModel, callGemini, getRegionSummaryBackend } from "./src/server/aiService";
import { resolveSafeImage, getRefinedUnsplashQuery, isRegionConsistent } from "./src/server/utils/imageResolver";
import { tripsCollection, profilesCollection, db, auth as firebaseAuth } from "./src/server/db";
import { verifyFirebaseIdToken } from "./src/server/utils/firebaseTokenVerifier";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { body, validationResult } from "express-validator";
import { authenticateJWT, AuthenticatedRequest } from "./src/server/middleware/auth";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
// @ts-ignore
import xss from "xss-clean";
import connectDB from "./src/server/config/db";
import authRoutes from "./src/server/routes/authRoutes";
import errorHandler from "./src/server/middleware/errorMiddleware";
import axios from "axios";

import Itinerary from "./src/server/models/Itinerary";
import RegionSummary from "./src/server/models/RegionSummary";
import Payment from "./src/server/models/Payment";
import Razorpay from "razorpay";
import crypto from "crypto";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // Connect to MongoDB
  await connectDB();

  const app = express();
  const PORT = 3000;

  // Fix: Trust proxy for rate limiting behind Cloud Run proxy
  app.set("trust proxy", 1);

  // Security & Middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for Vite dev server compatibility
  }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(cors());

  // Data sanitization against NoSQL query injection
  app.use(mongoSanitize());

  // Data sanitization against XSS
  app.use(xss());

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Increased from 100 to 1000 to handle data-heavy exploration
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    validate: { trustProxy: false },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json({
        message: "Thoda sabr rakhein... you're traveling too fast! Please wait a moment."
      });
    }
  });
  app.use("/api", limiter);

  // Mount Mongodb Auth Routes
  app.use("/api/v1/auth", authRoutes);

  // --- External API Proxies ---

  // Curated Local Image Search Proxy
  app.get("/api/images/search", async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ success: false, message: "Query is required" });

    const qStr = query as string;

    try {
      const source = "curated-library";
      const rawImages = [
        { url: undefined, alt: `Majestic ${qStr} View 1`, photographer: "ATRAV Curator" },
        { url: undefined, alt: `Majestic ${qStr} View 2`, photographer: "ATRAV Curator" },
        { url: undefined, alt: `Majestic ${qStr} View 3`, photographer: "ATRAV Curator" },
        { url: undefined, alt: `Majestic ${qStr} View 4`, photographer: "ATRAV Curator" }
      ];

      // Run every item through our high-contrast image validation proxy (resolves local curated options immediately)
      const validatedImages = await Promise.all(
        rawImages.map(async (img, idx) => {
          const safeUrl = await resolveSafeImage(undefined, qStr, [], idx);
          return {
            ...img,
            url: safeUrl
          };
        })
      );

      res.json({ success: true, data: validatedImages, source });
    } catch (error: any) {
      console.error("Image search proxy error:", error.message);
      // Absolute failsafe fallback to local cinematic path
      const safeUrl = await resolveSafeImage(undefined, qStr);
      res.json({
        success: true,
        data: [{
          url: safeUrl,
          alt: `Majestic views of ${qStr}`,
          photographer: "ATRAV Curator"
        }],
        source: "ultimate-backup"
      });
    }
  });

  // Nominatim (OSM) Proxy
  app.get("/api/places/search", async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ success: false, message: "Query is required" });

    try {
      const response = await axios.get(`https://nominatim.openstreetmap.org/search`, {
        params: {
          q: query,
          format: "json",
          limit: 10,
          addressdetails: 1,
          countrycodes: "in" // Prioritize results from India
        },
        headers: {
          "User-Agent": "ATRAV-App/1.0"
        }
      });
      res.json({ success: true, data: response.data });
    } catch (error: any) {
      console.error("Nominatim Error:", error.response?.data || error.message);
      res.status(500).json({ success: false, message: "Error searching places" });
    }
  });

  // --- Itinerary Routes (MongoDB with Firestore Fallback) ---

  // Save itinerary
  app.post("/api/itineraries", async (req, res) => {
    try {
      const isMongoConnected = mongoose.connection.readyState === 1;
      if (!isMongoConnected) {
        // Fallback to Firestore
        const docRef = await db.collection("itineraries").add({
          ...req.body,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const id = docRef.id;
        // Save to savedTrips as well for compatibility
        await db.collection("savedTrips").doc(id).set({
          ...req.body,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return res.status(201).json({ success: true, data: { _id: id, id, ...req.body } });
      }

      const itinerary = await Itinerary.create(req.body);
      res.status(201).json({ success: true, data: itinerary });
    } catch (error: any) {
      try {
        console.warn("MongoDB write failed, falling back to Firestore:", error.message);
        const docRef = await db.collection("itineraries").add({
          ...req.body,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const id = docRef.id;
        await db.collection("savedTrips").doc(id).set({
          ...req.body,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return res.status(201).json({ success: true, data: { _id: id, id, ...req.body } });
      } catch (fallbackErr: any) {
        res.status(400).json({ success: false, message: error.message });
      }
    }
  });

  // Get user itineraries
  app.get("/api/itineraries/user/:userId", async (req, res) => {
    try {
      const isMongoConnected = mongoose.connection.readyState === 1;
      if (!isMongoConnected) {
        // Fetch from Firestore itineraries collection where userId or creatorId is userId
        const snapshot = await db.collection("itineraries")
          .where("userId", "==", req.params.userId)
          .get();
        const trips = snapshot.docs.map(doc => ({ id: doc.id, _id: doc.id, ...doc.data() }));
        return res.json({ success: true, data: trips });
      }

      const itineraries = await Itinerary.find({ creatorId: req.params.userId }).sort({ createdAt: -1 });
      res.json({ success: true, data: itineraries });
    } catch (error: any) {
      try {
        console.warn("MongoDB find failed, falling back to Firestore:", error.message);
        const snapshot = await db.collection("itineraries")
          .where("userId", "==", req.params.userId)
          .get();
        const trips = snapshot.docs.map(doc => ({ id: doc.id, _id: doc.id, ...doc.data() }));
        return res.json({ success: true, data: trips });
      } catch (fallbackErr) {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  // Get single itinerary
  app.get("/api/itineraries/:id", async (req, res) => {
    try {
      const isMongoConnected = mongoose.connection.readyState === 1;
      if (!isMongoConnected) {
        let docSnap = await db.collection("itineraries").doc(req.params.id).get();
        if (!docSnap.exists) {
          docSnap = await db.collection("savedTrips").doc(req.params.id).get();
        }
        if (!docSnap.exists) {
          return res.status(404).json({ success: false, message: "Not found" });
        }
        return res.json({ success: true, data: { id: docSnap.id, _id: docSnap.id, ...docSnap.data() } });
      }

      const itinerary = await Itinerary.findById(req.params.id);
      if (!itinerary) {
        // Fallback check in Firestore
        let docSnap = await db.collection("itineraries").doc(req.params.id).get();
        if (!docSnap.exists) {
          docSnap = await db.collection("savedTrips").doc(req.params.id).get();
        }
        if (!docSnap.exists) {
          return res.status(404).json({ success: false, message: "Not found" });
        }
        return res.json({ success: true, data: { id: docSnap.id, _id: docSnap.id, ...docSnap.data() } });
      }
      res.json({ success: true, data: itinerary });
    } catch (error: any) {
      try {
        console.warn("MongoDB findById failed, falling back to Firestore:", error.message);
        let docSnap = await db.collection("itineraries").doc(req.params.id).get();
        if (!docSnap.exists) {
          docSnap = await db.collection("savedTrips").doc(req.params.id).get();
        }
        if (!docSnap.exists) {
          return res.status(404).json({ success: false, message: "Not found" });
        }
        return res.json({ success: true, data: { id: docSnap.id, _id: docSnap.id, ...docSnap.data() } });
      } catch (fallbackErr) {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  // Delete itinerary
  app.delete("/api/itineraries/:id", async (req, res) => {
    try {
      const isMongoConnected = mongoose.connection.readyState === 1;
      if (!isMongoConnected) {
        await db.collection("itineraries").doc(req.params.id).delete();
        await db.collection("savedTrips").doc(req.params.id).delete();
        return res.json({ success: true, message: "Deleted successfully" });
      }

      const itinerary = await Itinerary.findByIdAndDelete(req.params.id);
      if (!itinerary) {
        await db.collection("itineraries").doc(req.params.id).delete();
        await db.collection("savedTrips").doc(req.params.id).delete();
        return res.json({ success: true, message: "Deleted successfully" });
      }
      res.json({ success: true, message: "Deleted successfully" });
    } catch (error: any) {
      try {
        console.warn("MongoDB delete failed, falling back to Firestore delete:", error.message);
        await db.collection("itineraries").doc(req.params.id).delete();
        await db.collection("savedTrips").doc(req.params.id).delete();
        return res.json({ success: true, message: "Deleted successfully" });
      } catch (fallbackErr) {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  // Legacy/Firebase Routes (Retained for compatibility or mixed usage if needed)
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password, name } = req.body;
      const userRecord = await firebaseAuth.createUser({
        email,
        password,
        displayName: name,
      });
      // ... (rest of old firebase logic if still needed)
      
      // Initialize profile
      await profilesCollection.doc(userRecord.uid).set({
        email,
        name,
        createdAt: new Date(),
        updatedAt: new Date(),
        isPremium: false,
        preferences: {
          budget: "balanced",
          travelStyle: "adventure",
          interests: [],
          food: "any"
        }
      });

      res.status(201).json({ uid: userRecord.uid, message: "Welcome to the Tribe." });
    } catch (error: any) {
      console.error("Registration Error:", error);
      res.status(400).json({ message: error.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { token } = req.body;
    try {
      if (!token) return res.status(400).json({ message: "Token required" });
      const decodedToken = await verifyFirebaseIdToken(token);
      res.json({ uid: decodedToken.uid, message: "Cipher accepted." });
    } catch (error: any) {
      console.error("Firebase Login Verification Error:", error.message);
      res.status(401).json({ message: "Invalid credentials or session expired." });
    }
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
      const link = await firebaseAuth.generatePasswordResetLink(email);
      // In a real app, you'd email this link.
      res.json({ message: "Reset link generated.", link });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // User Profile & Preferences
  app.get("/api/user/profile", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let data = {
        role: "free",
        isPremium: false,
        preferences: {
          budget: "balanced",
          travelStyle: "adventure",
          interests: [],
          food: "any"
        }
      };

      try {
        const doc = await profilesCollection.doc(req.user.uid).get();
        if (doc.exists) {
          data = doc.data() as any;
        }
      } catch (dbErr: any) {
        console.warn("Backend profilesCollection.get lookup bypassed:", dbErr.message);
      }

      res.json(data);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.put("/api/user/profile", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const updateData = { ...req.body, updatedAt: new Date() };
      
      try {
        await profilesCollection.doc(req.user.uid).update(updateData);
      } catch (dbErr: any) {
        console.warn("Backend profilesCollection update bypassed:", dbErr.message);
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/user/preferences", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let preferences = {
        budget: "balanced",
        travelStyle: "adventure",
        interests: [],
        food: "any"
      };

      try {
        const doc = await profilesCollection.doc(req.user.uid).get();
        if (doc.exists && doc.data()?.preferences) {
          preferences = doc.data()?.preferences;
        }
      } catch (dbErr: any) {
        console.warn("Backend profilesCollection preferences lookup bypassed:", dbErr.message);
      }

      res.json(preferences);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.put("/api/user/preferences", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      try {
        await profilesCollection.doc(req.user.uid).update({ 
          preferences: req.body,
          updatedAt: new Date()
        });
      } catch (dbErr: any) {
        console.warn("Backend profilesCollection update preferences bypassed:", dbErr.message);
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/user/activity", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let tripsList: any[] = [];
      try {
        const recentTrips = await tripsCollection
          .where("userId", "==", req.user.uid)
          .orderBy("createdAt", "desc")
          .limit(5)
          .get();
        tripsList = recentTrips.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (dbErr: any) {
        console.warn("Backend tripsCollection lookup bypassed:", dbErr.message);
      }
      
      res.json({
        recentTrips: tripsList,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Premium Itinerary Generation
  app.post(
    "/api/itinerary/generate",
    authenticateJWT,
    [
      body("destination").notEmpty().trim(),
      body("duration").isNumeric(),
      body("budget").notEmpty(),
      body("travelers").notEmpty(),
      body("travelStyle").notEmpty(),
      body("interests").isArray(),
      body("startingLocation").notEmpty(),
    ],
    async (req: AuthenticatedRequest, res: any) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      try {
        const { 
          destination, 
          duration, 
          budget, 
          travelers, 
          travelStyle, 
          interests, 
          startingLocation,
          isPremium,
          weatherSmartPacking
        } = req.body;

        // Fetch user preferences and check daily generations limit
        let preferences = undefined;
        if (req.user) {
          try {
            const profileDoc = await profilesCollection.doc(req.user.uid).get();
            if (profileDoc.exists) {
              const profileData = profileDoc.data();
              preferences = profileData?.preferences;

              // Freemium Daily Limit Check
              const role = profileData?.role || "free";
              const isPremiumUser = role === "premium" || role === "admin";
              if (!isPremiumUser) {
                const todayStr = new Date().toDateString();
                const lastGenDate = profileData?.lastGenerationDate || "";
                const count = lastGenDate === todayStr ? (profileData?.dailyGenerationsCount || 0) : 0;

                if (count >= 3) {
                  return res.status(403).json({
                    success: false,
                    message: "You’ve reached today’s free limit. Upgrade to Premium for unlimited itinerary planning."
                  });
                }
              }
            }
          } catch (dbErr: any) {
            console.warn("Backend profile preferences and limit check bypassed:", dbErr.message);
          }
        }

        const itinerary = await generateItineraryBackend({ 
          destination, 
          days: duration, 
          budget, 
          travelers, 
          style: travelStyle, 
          interests, 
          startingLocation,
          isPremium,
          preferences,
          weatherSmartPacking
        });

        // Automatically save to user's history if authenticated
        if (req.user) {
          try {
            await tripsCollection.add({
              userId: req.user.uid,
              ...itinerary,
              inputParams: req.body,
              status: "generated"
            });
          } catch (dbErr: any) {
            console.warn("Backend tripsCollection write bypassed:", dbErr.message);
          }
        }

        res.json(itinerary);
      } catch (error: any) {
        console.error("AI Generation Error:", error);
        res.status(500).json({ message: error.message || "Something went wrong with the AI Engine." });
      }
    }
  );

  app.get("/api/trips", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let tripsList: any[] = [];
      try {
        const snapshot = await tripsCollection
          .where("userId", "==", req.user.uid)
          .orderBy("createdAt", "desc")
          .get();
          
        tripsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (dbErr: any) {
        console.warn("Backend trips lookup bypassed:", dbErr.message);
      }
      res.json(tripsList);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/trips", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const tripData = req.body;
      
      let savedId = "temp-" + Date.now();
      try {
        const docRef = await tripsCollection.add({
          ...tripData,
          userId: req.user.uid,
          createdAt: new Date()
        });
        savedId = docRef.id;
      } catch (dbErr: any) {
        console.warn("Backend trip save bypassed:", dbErr.message);
      }
      res.json({ id: savedId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/trips/:id", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let authorized = true;
      try {
        const tripRef = tripsCollection.doc(req.params.id);
        const doc = await tripRef.get();
        if (doc.exists) {
          if (doc.data()?.userId !== req.user.uid) {
            authorized = false;
          } else {
            await tripRef.delete();
          }
        }
      } catch (dbErr: any) {
        console.warn("Backend trip delete/validation bypassed:", dbErr.message);
      }
      
      if (!authorized) return res.status(403).json({ message: "Forbidden" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/ai/tools", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const { tool, prompt } = req.body;
      const result = await generateGeneralAITool(tool, prompt, req.user.isPremium || false);
      res.json({ result });
    } catch (error: any) {
      console.error("AI Tool Error:", error);
      res.status(500).json({ message: "AI Tool meditation failed" });
    }
  });

  app.get("/api/recommendations", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      // Logic for elite locations based on brand vibe
      const locations = [
        { name: "Nubra Valley, Ladakh", tag: "Luxury Escape", image: "https://images.unsplash.com/photo-1581793745862-99fde7fa73d2?auto=format&fit=crop&q=80" },
        { name: "Udaipur, Rajasthan", tag: "Heritage Stay", image: "https://images.unsplash.com/photo-1590050752117-238cb0fb12b1?auto=format&fit=crop&q=80" },
        { name: "Munnar, Kerala", tag: "Slow Travel", image: "https://images.unsplash.com/photo-1589982841200-7216a75f12e8?auto=format&fit=crop&q=80" }
      ];
      res.json(locations);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/ai/suggestions", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      
      let prefs = {};
      try {
        const profileDoc = await profilesCollection.doc(req.user.uid).get();
        if (profileDoc.exists) {
          prefs = profileDoc.data()?.preferences || {};
        }
      } catch (dbErr: any) {
        console.warn("Backend suggestions profile fetch bypassed:", dbErr.message);
      }
      
      const prompt = `Given these traveler preferences: ${JSON.stringify(prefs)}, suggest 3 unique, luxury Indian travel themes for their next Safarnama. Keep it short and cinematic.`;
      
      try {
        if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.length < 10) {
          throw new Error("Gemini API Key Missing");
        }
        const model = getModel("gemini-3.5-flash", false);
        const text = await callGemini(model, prompt, false);
        res.json({ suggestions: text });
      } catch (err) {
        // Fallback for suggestions
        res.json({ suggestions: "• Royal Heritage Trails\n• Hidden Himalayan Sanctuaries\n• Coastal Soul Escapes" });
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/destinations/explore", async (req, res) => {
    const { category, count } = req.query;
    try {
      const destinations = await exploreDestinationsBackend(
        (category as string) || "Luxury Escapes",
        count ? parseInt(count as string) : 6
      );
      res.json({ success: true, data: destinations });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/destinations/:name/details", async (req, res) => {
    try {
      const details = await getDestinationDetailsBackend(req.params.name);
      res.json({ success: true, data: details });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/destinations/:name/explore-summary", async (req, res) => {
    const { name } = req.params;
    try {
      // Try MongoDB first if connected
      const isMongoConnected = mongoose.connection.readyState === 1;
      
      if (isMongoConnected) {
        const cached = await (RegionSummary as any).findOne({ name: name.toLowerCase() });
        if (cached) {
          return res.json({ success: true, data: cached });
        }
      }

      // Check Firestore as second layer cache
      let cacheDoc = null;
      try {
        const cacheRef = db.collection("region_summaries").doc(name.toLowerCase());
        cacheDoc = await cacheRef.get();
        if (cacheDoc && cacheDoc.exists) {
          return res.json({ success: true, data: cacheDoc.data() });
        }
      } catch (firestoreErr: any) {
        console.warn("Firestore cache read bypassed due to permission/config error:", firestoreErr.message);
      }

      const summary = await getRegionSummaryBackend(name);
      
      // Save to caches
      if (summary.success && summary.data) {
        try {
          if (isMongoConnected) {
            await (RegionSummary as any).findOneAndUpdate(
              { name: name.toLowerCase() },
              { ...summary.data, name: name.toLowerCase() },
              { upsert: true, new: true }
            );
          }
          
          try {
            const cacheRef = db.collection("region_summaries").doc(name.toLowerCase());
            await cacheRef.set(summary.data);
          } catch (firestoreWriteErr: any) {
            console.warn("Firestore cache write bypassed:", firestoreWriteErr.message);
          }
        } catch (cacheErr) {
          console.error("Cache Write Error:", cacheErr);
        }
      }
      
      res.json(summary);
    } catch (error: any) {
      console.error("Explore Summary API Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Lazy-initialize Razorpay configuration
  let razorpayInstance: any = null;
  function getRazorpay() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new Error("Razorpay API Key ID or Secret is not defined in environment variables.");
    }
    if (!razorpayInstance) {
      razorpayInstance = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });
    }
    return razorpayInstance;
  }

  // Webhook Verification (Optional but requested for complete integration)
  app.post("/api/payment/webhook", express.json(), async (req: any, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "razorpay_webhook_secret_fallback";
    if (!signature) {
      return res.status(400).send("Signature missing from header context.");
    }
    try {
      const shasum = crypto.createHmac("sha256", secret);
      shasum.update(JSON.stringify(req.body));
      const digest = shasum.digest("hex");
      if (digest === signature) {
        console.log("Razorpay Webhook signature matches! Event:", req.body.event);
        return res.json({ status: "ok" });
      } else {
        return res.status(400).send("Invalid webhook signature.");
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Razorpay Order Creation Route
  app.post("/api/payment/order", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Yatri session is expired. Please login." });
      }

      const { amount, planId, billingName, billingPhone } = req.body;
      if (!amount || !planId) {
        return res.status(400).json({ success: false, message: "Plan information or amount is invalid." });
      }

      // Lazy load Razorpay to prevent compile/bootstrap crashes if secrets are missing
      let razorpay;
      try {
        razorpay = getRazorpay();
      } catch (keyErr: any) {
        console.warn("Razorpay credentials missing. Bootstrapping Sandbox mock order fallback.");
      }

      const amountInPaise = Math.round(parseFloat(amount) * 100);
      const receipt = `rcpt_${req.user.uid.slice(-6)}_${Date.now()}`;

      let order;
      if (razorpay) {
        const options = {
          amount: amountInPaise,
          currency: "INR",
          receipt,
          notes: {
            userId: req.user.uid,
            email: req.user.email || "",
            planId,
            billingName: billingName || "",
            billingPhone: billingPhone || ""
          }
        };
        order = await razorpay.orders.create(options);
      } else {
        // Sandbox fallback order structure if credentials are not configured
        order = {
          id: `order_mock_${Math.random().toString(36).substring(2, 10)}`,
          entity: "order",
          amount: amountInPaise,
          amount_paid: 0,
          amount_due: amountInPaise,
          currency: "INR",
          receipt,
          status: "created",
          attempts: 0,
          notes: {
            userId: req.user.uid,
            email: req.user.email || "",
            planId,
            billingName: billingName || "",
            billingPhone: billingPhone || ""
          },
          created_at: Math.floor(Date.now() / 1000),
          isMock: true
        };
      }

      // Save initial payment intent in MongoDB if connected
      try {
        if (mongoose.connection.readyState === 1) {
          await Payment.create({
            userId: req.user.uid,
            email: req.user.email || "yatri@atravtravel.com",
            orderId: order.id,
            amount: parseFloat(amount),
            planId,
            status: "created",
            receipt,
            billingName: billingName || "",
            billingPhone: billingPhone || ""
          });
        }
      } catch (dbErr: any) {
        console.warn("Failed to log payment order in MongoDB:", dbErr.message);
      }

      res.status(201).json({
        success: true,
        data: order,
        keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_mock_keys_active"
      });
    } catch (error: any) {
      console.error("Payment Order Creation failed:", error);
      res.status(500).json({ success: false, message: error.message || "Apologies, booking engine is processing too heavily." });
    }
  });

  // Razorpay Payment Verification Route
  app.post("/api/payment/verify", authenticateJWT, async (req: AuthenticatedRequest, res: any) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: "Yatri session is expired. Please login." });
      }

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, billingName, billingPhone, amount } = req.body;
      
      if (!razorpay_order_id || !razorpay_payment_id) {
        return res.status(400).json({ success: false, message: "Missing required payment transaction parameters." });
      }

      let isVerified = false;
      let isMock = razorpay_order_id.startsWith("order_mock_");

      if (isMock) {
        isVerified = true;
      } else {
        try {
          const keySecret = process.env.RAZORPAY_KEY_SECRET;
          if (!keySecret) {
            throw new Error("Razorpay Secret is missing");
          }
          
          const generated_signature = crypto
            .createHmac("sha256", keySecret)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

          isVerified = generated_signature === razorpay_signature;
        } catch (err: any) {
          console.error("Signature verification failed:", err);
          return res.status(400).json({ success: false, message: "Payment signature is invalid or could not be verified." });
        }
      }

      if (!isVerified) {
        return res.status(400).json({ success: false, message: "Kshama karein... Signature mismatch. Authentication failed." });
      }

      // Generate full premium subscription expiry date
      const expiryDate = new Date();
      if (planId === "elite_yearly") {
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      } else {
        expiryDate.setMonth(expiryDate.getMonth() + 1); // standard monthly premium or explorer
      }
      const premiumTillStr = expiryDate.toISOString();

      // 1. Upgrade in Firebase Firestore (users collection)
      try {
        await profilesCollection.doc(req.user.uid).set({
          role: "premium",
          subscriptionId: razorpay_order_id,
          premiumTill: premiumTillStr,
          updatedAt: new Date()
        }, { merge: true });

        // Save into premiumUsers collection
        await db.collection("premiumUsers").doc(req.user.uid).set({
          userId: req.user.uid,
          email: req.user.email || "yatri@atravtravel.com",
          role: "premium",
          subscriptionId: razorpay_order_id,
          premiumTill: premiumTillStr,
          updatedAt: new Date()
        }, { merge: true });
      } catch (firestoreErr: any) {
        console.warn("Failed to upgrade Firestore database for user:", firestoreErr.message);
      }

      // 2. Upgrade in MongoDB (User collection)
      try {
        if (mongoose.connection.readyState === 1) {
          const User = mongoose.model("User");
          await User.findOneAndUpdate(
            { email: req.user.email },
            { role: "premium" },
            { new: true }
          );
        }
      } catch (mongoErr: any) {
        console.warn("Failed to upgrade MongoDB for user:", mongoErr.message);
      }

      // 3. Save logs & generate Invoice in MongoDB Payments collection
      const invoiceNumber = `INV-2026-${Math.floor(100000 + Math.random() * 900000)}`;
      try {
        if (mongoose.connection.readyState === 1) {
          await Payment.findOneAndUpdate(
            { orderId: razorpay_order_id },
            {
              paymentId: razorpay_payment_id,
              signature: razorpay_signature || "MOCK_SIGNATURE",
              status: "paid",
              invoiceNumber,
              billingName: billingName || req.user.email?.split("@")[0] || "Yatri",
              billingPhone: billingPhone || ""
            },
            { upsert: true, new: true }
          );
        }
      } catch (payDbErr: any) {
        console.warn("Failed to persist payment log in MongoDB:", payDbErr.message);
      }

      res.json({
        success: true,
        message: "Access Granted. Safe travels, premium yatri!",
        invoiceNumber,
        subscriptionId: razorpay_order_id,
        premiumTill: premiumTillStr
      });
    } catch (error: any) {
      console.error("Signature verification error:", error);
      res.status(500).json({ success: false, message: error.message || "Internal server error during verification process." });
    }
  });

  // Health check

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Error Handler Middleware (must be after routes)
  app.use(errorHandler);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
