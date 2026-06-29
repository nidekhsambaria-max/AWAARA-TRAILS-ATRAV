# Security Specification for SAFARANA

## Data Invariants
1. **Identity Integrity**: A user can only modify their own profile, saved trips, and usage counters.
2. **Role Immutability**: Users cannot promote themselves to 'premium' or 'admin' directly. Roles can only be updated by the system or an admin.
3. **Relational Sync**: A subscription can only be created if the user exists.
4. **Usage Protection**: Usage counters are incremented by the system (AI service) but read by the user. Users cannot artificially reset their usage.
5. **Itinerary Ownership**: Itineraries are private by default; owners can modify, others can only read if `isPublic` is true.
6. **Payment Proof**: Payments are system-written; users can only read their own payment history.

## The Dirty Dozen Payloads (Negative Tests)

1. **Self-Promotion**: Authenticated user trying to set `role: "admin"` on their user document.
2. **Shadow Field Injection**: Creating an itinerary with a hidden field `systemInternalRank: 99`.
3. **ID Poisoning**: Using a 2KB string as a document ID for an itinerary.
4. **PII Leak**: Non-owner trying to read the `email` of another user.
5. **Orphaned Subscriptions**: Creating a subscription for a non-existent `userId`.
6. **Usage Reset**: User trying to update `usage/uid` to set `aiGenerations: 0`.
7. **Itinerary Hijack**: Authenticated user trying to update another user's itinerary.
8. **Subscription Spoofing**: User trying to set `status: "active"` on an expired subscription.
9. **Creation Timestamp Spoofing**: Setting `createdAt` to a date in 2020.
10. **Admin Bypass**: Trying to delete a system log without being an admin.
11. **Excessive List Scrape**: Querying all users' emails without specific ownership filters.
12. **Negative Payment**: Trying to create a payment with `amount: -100`.

## Test Runner (Draft Plan)
A suite of tests will verify that all the above unauthorized operations return `PERMISSION_DENIED`.
