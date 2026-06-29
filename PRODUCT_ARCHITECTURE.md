# Wandr AI Product Architecture

## 1. Vision & Core Flow
Wandr AI is a premium, AI-driven travel orchestration platform.
**User Flow:** Landing → Destination Input → Style Calibration → AI Generation → Cinematic Itinerary → Save/Share.

## 2. Page Map
- **Landing (/)**: Hero, value props, social proof, and "Quick Start" form.
- **Planner (/plan)**: Detailed customization (budget, group type, pace, photography focus).
- **Itinerary (/trip/:id)**: The primary result page. Tabs for days, interactive map, creator tools.
- **Dashboard (/dashboard)**: Personal collection of saved and past trips.
- **Community (/explore)**: Publicly shared itineraries from other creators.
- **Auth (/login, /signup)**: Minimalist, credential-less focus (Google/Magic Link).

## 3. Tech Stack (Revised for Environment)
- **Frontend**: React 19 + Vite + Tailwind CSS 4.
- **Animations**: Motion (framer-motion).
- **Backend**: Express.js (Node.js) on port 3000.
- **Storage/DB**: MongoDB (Itineraries) & Firebase Auth/Firestore (Profiles/Auth).
- **AI Engine**: Gemini 1.5 Flash (Primary for speed).
- **Maps**: OpenStreetMap via Leaflet & `react-leaflet`.

## 4. Data Models
- **Users (Firebase)**: `{ uid, email, displayName, photoURL, premiumStatus, createdAt }`
- **Itineraries (MongoDB)**: `{ _id, creatorId, destination, days, budget, style, data: { ... }, isPublic, createdAt }`
- **SavedTrips**: `{ userId, tripId, savedAt }`
- **CommunityPosts**: `{ id, tripId, authorId, likes, commentsCount, createdAt }`

## 5. Mobile UX Strategy
- **Sticky Navigation**: Bottom bar for core actions (Home, Plan, Explore, Profile).
- **Floating AI**: Minimalist chat bubble for quick local queries.
- **Gestures**: Swipeable cards for day-by-day views.

## 6. Development Phases
- **Phase 1**: Brand & Landing (Done).
- **Phase 2**: Full-Stack Setup & Firebase Auth/DB.
- **Phase 3**: AI Integration (Gemini Service).
- **Phase 4**: Map Integration & Result UI.
- **Phase 5**: User Dashboard & Community Features.
