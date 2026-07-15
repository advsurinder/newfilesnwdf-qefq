# Order Monitor — Setup Guide

This is the only setup you need. No coding, no extra accounts required.

## Step 1 — Get your Firebase config (2 minutes)

1. Go to https://console.firebase.google.com and open your existing project (the one your site already saves to).
2. Click the gear icon (top left) → **Project settings**.
3. Scroll to **Your apps**. If you already have a web app listed, click it and find **SDK setup and configuration** → select **Config**. If you don't have one yet, click **Add app → Web (</>)**, name it anything, and it'll show you the same config block.
4. You'll see something like this — copy the whole thing:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "yourproject.firebaseapp.com",
  projectId: "yourproject",
  storageBucket: "yourproject.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

## Step 2 — Paste it into the file

1. Open `order-monitor.html` in any text editor (Notepad, VS Code, even GitHub's own editor).
2. Find this block near the top of the `<script>` section (search for `firebaseConfig`):

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  ...
};
```

3. Replace it with the real values you copied in Step 1.
4. Save.

## Step 3 — Turn on Firestore access (important — do this or the page won't load data)

1. In Firebase Console, go to **Firestore Database** → **Rules** tab.
2. If it's brand new, it may be locked down by default. For now, to get moving fast, use:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

3. Click **Publish**.

**Heads up:** this rule means anyone with your Firebase config could read or write your data — fine to get started fast, but since this holds real customer data, you should lock it down properly later (add Firebase Authentication + rules that only allow your logged-in staff accounts). Ask me anytime and I'll set that up properly when you're ready — it's a quick follow-up, not a rebuild.

## Step 4 — Add it to your GitHub site

1. Go to your repo: `advsurinder/newfilesnwdf-qefq`
2. Click **Add file → Upload files**.
3. Upload `order-monitor.html`.
4. Commit the change.
5. Visit `https://advsurinder.github.io/newfilesnwdf-qefq/order-monitor.html` — that's your live tool.
6. (Optional) Add a link to it from your main page's navigation so you don't have to remember the URL.

## How to use it day to day

- **New order comes in on DoorDash** → click **+ New Order** → type name, phone, order #, items, cost → their history pops up as you type → click **Confirm** or **Dispute**.
- Confirming starts a 4-minute "ready for pickup" countdown automatically.
- Once ready, click **Driver arrived at store** → after 1 minute it asks if the driver is actually there — you decide.
- **Dispute** drafts a message with the customer's real history, ready to copy into DoorDash support chat — nothing sends on its own.
- **Upload order history** button lets you bulk-import past orders from an Excel/CSV export (any column names — it figures out name, phone, order #, items, charges, comments automatically).
- Customer history builds up automatically from every order you log, whether typed one at a time or bulk-uploaded.

## Known limits, so nothing surprises you

- Timers (4-minute pickup, 1-minute driver check) only run while this page is open in a browser tab. Closing the tab pauses them.
- Nothing here reads DoorDash's Merchant Portal directly or clicks anything for you there — every DoorDash-facing action (confirming, disputing, reassigning drivers) is something you do yourself, using the info and drafts this tool prepares.
- If you ever want automatic order capture (no typing at all) or reliable timers even with the tab closed, both are possible as a next step — just ask.
